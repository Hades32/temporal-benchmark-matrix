import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

let config = new pulumi.Config();

let dbPrefix = "POSTGRES";
let dbPort = 5432;
let dbType = "postgresql";

const historyPodCount = (shardCount: number) => shardCount / 512
const matchingPodCount = (partitions: number) => partitions

const envStack = new pulumi.StackReference(config.require("EnvironmentStackName"));

const cluster = new eks.Cluster(pulumi.getStack(), {
    vpcId: envStack.getOutput("VpcId"),
    publicSubnetIds: envStack.getOutput("PublicSubnetIds"),
    privateSubnetIds: envStack.getOutput("PrivateSubnetIds"),
    nodeAssociatePublicIpAddress: false,
    instanceType: config.require('NodeType'),
    desiredCapacity: config.requireNumber('NodeCount'),
    minSize: config.requireNumber('NodeCount'),
    maxSize: config.requireNumber('NodeCount')
});

export const clusterName = cluster.eksCluster.name;
export const kubeconfig = cluster.kubeconfig;

const rdsSecurityGroup = new aws.ec2.SecurityGroup(pulumi.getStack() + "-rds", {
    vpcId: envStack.getOutput("VpcId"),
    ingress: [
        {
            fromPort: dbPort,
            toPort: dbPort,
            protocol: "tcp",
            securityGroups: [cluster.nodeSecurityGroup.id]
        }
    ]
});

const rdsInstance = new aws.rds.Instance(pulumi.getStack(), {
    availabilityZone: envStack.requireOutput('AvailabilityZones').apply(zones => zones[0]),
    dbSubnetGroupName: envStack.requireOutput('RdsSubnetGroupName'),
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    identifierPrefix: pulumi.concat("persistence-", config.require('HistoryShards'), "-shards"),
    allocatedStorage: 100,
    engine: config.require("PersistenceEngine"),
    engineVersion: config.require("PersistenceEngineVersion"),
    instanceClass: config.require("PersistenceInstance"),
    parameterGroupName: config.require("PersistenceParameterGroupName"),
    skipFinalSnapshot: true,
    username: "temporal",
    password: "temporal",
});

const temporalConfig = new k8s.core.v1.ConfigMap("temporal-env",
    {
        metadata: { name: "temporal-env" },
        data: {
            "DB": dbType,
            "DB_PORT": dbPort.toString(),
            "SQL_MAX_CONNS": "40",
            [`${dbPrefix}_SEEDS`]: rdsInstance.address,
            [`${dbPrefix}_USER`]: "temporal",
            [`${dbPrefix}_PWD`]: "temporal",
            "DBNAME": "temporal_persistence",
            "VISIBILITY_DBNAME": "temporal_visibility",
            "MYSQL_TX_ISOLATION_COMPAT": "true",
            "NUM_HISTORY_SHARDS": config.require("HistoryShards"),
        }
    },
    { provider: cluster.provider }
)

const temporalDynamicConfig = new k8s.core.v1.ConfigMap("temporal-dynamic-config",
    {
        metadata: { name: "temporal-dynamic-config" },
        data: {
            "dynamic_config.yaml": config.require("DynamicConfig")
        }
    },
    { provider: cluster.provider }
)

const workerConfig = new k8s.core.v1.ConfigMap("benchmark-worker-env",
    {
        metadata: { name: "benchmark-worker-env" },
        data: {
            "TEMPORAL_WORKFLOW_TASK_POLLERS": config.require("WorkerWorkflowPollers"),
			"TEMPORAL_ACTIVITY_TASK_POLLERS": config.require("WorkerActivityPollers"),
        }
    },
    { provider: cluster.provider }
)

const temporalAutoSetup = new k8s.batch.v1.Job("temporal-autosetup",
    {
        metadata: {
            name: "temporal-autosetup"
        },
        spec: {
            backoffLimit: 3,
            template: {
                spec: {
                    containers: [
                        {
                            name: "autosetup",
                            image: "temporalio/auto-setup:1.18.1",
                            imagePullPolicy: "IfNotPresent",
                            command: ["/etc/temporal/auto-setup.sh"],
                            envFrom: [
                                {
                                    configMapRef: { name: temporalConfig.metadata.name }
                                }
                            ]
                        }
                    ],
                    restartPolicy: "Never"
                }
            }
        }
    },
    {
        dependsOn: [temporalConfig],
        provider: cluster.provider
    }
)

const scaleDeployment = (name: string, replicas: number) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment" && obj.metadata.name === name) {
            obj.spec.replicas = replicas
        }
    }
}

new k8s.kustomize.Directory("monitoring",
    { directory: "../k8s/monitoring" },
    { provider: cluster.provider }
);

new k8s.kustomize.Directory("temporal",
    {
        directory: "../k8s/temporal",
        transformations: [
            scaleDeployment("temporal-history", historyPodCount(config.requireNumber("HistoryShards"))),
            scaleDeployment("temporal-matching", matchingPodCount(config.requireNumber("TaskQueuePartitions")))
        ]
    },
    {
        dependsOn: [temporalConfig, temporalDynamicConfig, temporalAutoSetup],
        provider: cluster.provider
    }
);

new k8s.kustomize.Directory("benchmark-workers",
    {
        directory: "../k8s/benchmark-workers",
        transformations: [
            scaleDeployment("benchmark-workers", config.requireNumber("WorkerCount"))
        ]
    },
    {
        dependsOn: [workerConfig],
        provider: cluster.provider
    }
);