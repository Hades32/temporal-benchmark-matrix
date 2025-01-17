import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as jsyaml from "js-yaml";

let config = new pulumi.Config();
const envStack = new pulumi.StackReference(config.require('EnvironmentStackName'), { name: config.require('EnvironmentStackName') });

const dynamicConfig = (config: TemporalConfig): pulumi.Output<Object> => {
    const dc = config.DynamicConfig || {};
    const matchingConfig = {
        'matching.numTaskqueueReadPartitions': [{ value: config.Matching.TaskQueuePartitions }],
        'matching.numTaskqueueWritePartitions': [{ value: config.Matching.TaskQueuePartitions }],
    }

    return pulumi.output({ ...dc, ...matchingConfig })
}

interface TemporalConfig {
    DynamicConfig: Object;
    Frontend: FrontendConfig;
    History: HistoryConfig;
    Matching: MatchingConfig;
    Workers: WorkerConfig;
    SoakTest: SoakTestConfig;
}

interface FrontendConfig {
    Pods: number;
    CPU: CPULimits;
    Memory: MemoryLimits;
}

interface HistoryConfig {
    Shards: number;
    Pods: number;
    CPU: CPULimits;
    Memory: MemoryLimits;
}

interface MatchingConfig {
    TaskQueuePartitions: number;
    Pods: number;
    CPU: CPULimits;
    Memory: MemoryLimits;
}

interface CPULimits {
    request: string;
    limit: string;
}

interface MemoryLimits {
    request: string;
    limit: string;
}

interface WorkerConfig {
    Pods: number;
    WorkflowPollers: number;
    ActivityPollers: number;
    CPU: CPULimits;
    Memory: MemoryLimits;
}

interface SoakTestConfig {
    ConcurrentWorkflows: number;
}

interface Cluster {
    name: pulumi.Output<string>;
    kubeconfig: pulumi.Output<any>;
    provider: k8s.Provider;
    securityGroup: pulumi.Output<string>;
    instanceRoles: pulumi.Output<aws.iam.Role[]>;
}

interface EKSClusterConfig {
    EnvironmentStackName: string;
    NodeType: string;
    NodeCount: number;
}

interface ClusterConfig {
    EKS: EKSClusterConfig | undefined;
}

interface VisibilityConfig {
    OpenSearch: OpenSearchConfig | undefined;
}

interface PersistenceConfig {
    RDS: RDSPersistenceConfig | undefined;
    Cassandra: CassandraPersistenceConfig | undefined;
    Visibility: VisibilityConfig;
}

interface RDSPersistenceConfig {
    EnvironmentStackName: string;
    Engine: string;
    EngineVersion: string;
    InstanceType: string;
    SingleAZ: boolean;
}

interface CassandraPersistenceConfig {
    NodeType: string;
    NodeCount: number;
    ReplicaCount: number;
};

type ConfigMapData = pulumi.Input<{[key: string]: pulumi.Input<string>}>;

interface OpenSearchConfig {
    InstanceType: string;
    EngineVersion: string;
}

interface Monitoring {
    GrafanaEndpoint: pulumi.Output<string>;
    PrometheusEndpoint: pulumi.Output<string>;
}

function createCluster(clusterConfig: ClusterConfig, persistenceConfig: PersistenceConfig): Cluster {
    if (clusterConfig.EKS != undefined) {
        return eksCluster(pulumi.getStack(), clusterConfig.EKS, persistenceConfig)
    }

    throw("invalid cluster config")
}

function eksCluster(name: string, config: EKSClusterConfig, persistenceConfig: PersistenceConfig): Cluster {
    const identity = aws.getCallerIdentity({});
    const role = pulumi.concat('arn:aws:iam::', identity.then(current => current.accountId), ':role/', envStack.getOutput('Role'));

    const kubeconfigOptions: eks.KubeconfigOptions = { roleArn: role }

    const cluster = new eks.Cluster(name, {
        providerCredentialOpts: kubeconfigOptions,
        vpcId: envStack.getOutput("VpcId"),
        publicSubnetIds: envStack.getOutput("PublicSubnetIds"),
        privateSubnetIds: envStack.getOutput("PrivateSubnetIds"),
        nodeAssociatePublicIpAddress: false,
        desiredCapacity: 10,
        minSize: 10,
        maxSize: 10,
    });

    cluster.createNodeGroup(name + '-temporal', {
        instanceType: config.NodeType,
        desiredCapacity: config.NodeCount,
        minSize: config.NodeCount,
        maxSize: config.NodeCount,
        labels: {
            dedicated: "temporal",
        },
        taints: {
            "dedicated": { value: "temporal", effect: "NoSchedule" }
        }
    })

    if (persistenceConfig.Cassandra) {
        const cassandraConfig = persistenceConfig.Cassandra;

        cluster.createNodeGroup(name + '-cassandra', {
            instanceType: cassandraConfig.NodeType,
            desiredCapacity: cassandraConfig.NodeCount,
            minSize: cassandraConfig.NodeCount,
            maxSize: cassandraConfig.NodeCount,
            labels: {
                dedicated: "cassandra",
            },
            taints: {
                "dedicated": { value: "cassandra", effect: "NoSchedule" }
            }
        })
    }

    return {
        name: cluster.eksCluster.name,
        kubeconfig: cluster.kubeconfig,
        provider: cluster.provider,
        securityGroup: cluster.nodeSecurityGroup.id,
        instanceRoles: cluster.instanceRoles,
    }
}

function createPersistence(config: PersistenceConfig, cluster: Cluster): ConfigMapData {
    let persistence: ConfigMapData | undefined;

    if (config.RDS != undefined) {
        persistence = rdsPersistence(pulumi.getStack(), config.RDS, cluster.securityGroup);
    } else if (config.Cassandra != undefined) {
        persistence = cassandraPersistence(pulumi.getStack(), config.Cassandra, cluster);
    }

    if (persistence == undefined) {
        throw("invalid persistence config")
    }

    return { ...persistence, ...createAdvancedVisibility(config.Visibility, cluster) }
}

function rdsPersistence(name: string, config: RDSPersistenceConfig, securityGroup: pulumi.Output<string>): ConfigMapData {
    let dbType: string;
    let dbPort: number;
    let dbPrefix: string;
    let dbExtras: ConfigMapData = {};

    if (config.Engine == "postgres" || config.Engine == "aurora-postgresql") {
        dbType = "postgresql";
        dbPort = 5432;
        dbPrefix = "POSTGRES";
    } else if (config.Engine == "mysql" || config.Engine == "aurora-mysql") {
        dbType = "mysql";
        dbPort = 3306;
        dbPrefix = "MYSQL";
        dbExtras = {
            "MYSQL_TX_ISOLATION_COMPAT": "true"
        };
    } else {
        throw("invalid RDS config");
    }

    const rdsSecurityGroup = new aws.ec2.SecurityGroup(name + "-rds", {
        vpcId: envStack.getOutput("VpcId"),
    });
    
    new aws.ec2.SecurityGroupRule(name + "-rds", {
        securityGroupId: rdsSecurityGroup.id,
        type: 'ingress',
        sourceSecurityGroupId: securityGroup,
        protocol: "tcp",
        fromPort: dbPort,
        toPort: dbPort,
    });

    let endpoint: pulumi.Output<String>;

    if (config.Engine == "aurora-postgresql" || config.Engine == "aurora-mysql") {
        const engine = config.Engine;

        const rdsCluster = new aws.rds.Cluster(name, {
            availabilityZones: envStack.requireOutput('AvailabilityZones'),
            dbSubnetGroupName: envStack.requireOutput('RdsSubnetGroupName'),
            vpcSecurityGroupIds: [rdsSecurityGroup.id],
            clusterIdentifierPrefix: name,
            engine: engine,
            engineVersion: config.EngineVersion,
            skipFinalSnapshot: true,
            masterUsername: "temporal",
            masterPassword: "temporal",
        });

        rdsCluster.availabilityZones.apply((zones) => {
            zones.forEach((z, _) => {
                new aws.rds.ClusterInstance(`${name}-${z}`, {
                    identifierPrefix: name,
                    clusterIdentifier: rdsCluster.id,
                    availabilityZone: z,
                    engine: engine,
                    engineVersion: config.EngineVersion,
                    instanceClass: config.InstanceType,
                    performanceInsightsEnabled: true,
                })
            })
        })

        endpoint = rdsCluster.endpoint;
    } else if (config.SingleAZ) {
        const engine = config.Engine;

        const rdsInstance = new aws.rds.Instance(name, {
            allocatedStorage: 1024,
            availabilityZone: envStack.requireOutput('AvailabilityZones').apply(zones => zones[0]),
            dbSubnetGroupName: envStack.requireOutput('RdsSubnetGroupName'),
            vpcSecurityGroupIds: [rdsSecurityGroup.id],
            identifierPrefix: name,
            engine: engine,
            engineVersion: config.EngineVersion,
            instanceClass: config.InstanceType,
            skipFinalSnapshot: true,
            username: "temporal",
            password: "temporal",
        });
        
        endpoint = rdsInstance.address;
    } else {
        const engine = config.Engine;

        const rdsCluster = new aws.rds.Cluster(name, {
            allocatedStorage: 1024,
            availabilityZones: envStack.requireOutput('AvailabilityZones'),
            dbSubnetGroupName: envStack.requireOutput('RdsSubnetGroupName'),
            vpcSecurityGroupIds: [rdsSecurityGroup.id],
            clusterIdentifierPrefix: name,
            engine: engine,
            engineVersion: config.EngineVersion,
            dbClusterInstanceClass: config.InstanceType,
            skipFinalSnapshot: true,
            masterUsername: "temporal",
            masterPassword: "temporal",
        });
        
        endpoint = rdsCluster.endpoint;
    }

    return {
        "NUM_HISTORY_SHARDS": temporalConfig.History.Shards.toString(),    
        "DB": dbType,
        "DB_PORT": dbPort.toString(),
        [`${dbPrefix}_SEEDS`]: endpoint.apply(s => s.toString()),
        [`${dbPrefix}_USER`]: "temporal",
        [`${dbPrefix}_PWD`]: "temporal",
        "DBNAME": "temporal_persistence",
        ...dbExtras,
    };
}

function cassandraPersistence(name: string, config: CassandraPersistenceConfig, cluster: Cluster): ConfigMapData {
    const namespace = new k8s.core.v1.Namespace("cassandra", { metadata: { name: "cassandra" } }, { provider: cluster.provider })
    
    const ebsDriver = new aws.eks.Addon("aws-ebs-csi-driver", {
        clusterName: cluster.name,
        addonName: "aws-ebs-csi-driver",
        addonVersion: "v1.17.0-eksbuild.1",
    });
    
    cluster.instanceRoles.apply(roles => {
        roles.forEach((role, i) => {
            new aws.iam.RolePolicyAttachment(`ebs-driver-role-policy-${i}`, { role: role, policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy" })
        })
    })

    const cassandra = new k8s.helm.v3.Chart('cassandra',
        {
            chart: "cassandra",
            version: "9.7.5",
            namespace: "cassandra",
            fetchOpts:{
                repo: "https://charts.bitnami.com/bitnami",
            },
            values: {
                "dbUser": {
                    "user": "temporal",
                    "password": "temporal",
                },
                "replicaCount": config.ReplicaCount,
                "persistence": {
                    "commitLogMountPath": "/bitnami/cassandra/commitlog",
                },
                "tolerations": [
                    { key: "dedicated", operator: "Equal", value: "cassandra", effect: "NoSchedule" },
                ],
            },
        },
        { dependsOn: [namespace, ebsDriver], provider: cluster.provider }
    )

    return {
        "NUM_HISTORY_SHARDS": temporalConfig.History.Shards.toString(),
        "DB": "cassandra",
        "DB_PORT": "9042",
        "CASSANDRA_SEEDS": "cassandra.cassandra.svc.cluster.local",
        "CASSANDRA_USER": "temporal",
        "CASSANDRA_PASSWORD": "temporal",
        "CASSANDRA_REPLICATION_FACTOR": "3",
        "DBNAME": "temporal_persistence",
    };
}

function opensearchVisibility(name: string, config: OpenSearchConfig, cluster: Cluster): ConfigMapData {
    const opensearchSecurityGroup = new aws.ec2.SecurityGroup(name + "-opensearch", {
        vpcId: envStack.getOutput("VpcId"),
    });
    
    new aws.ec2.SecurityGroupRule(name + "-opensearch", {
        securityGroupId: opensearchSecurityGroup.id,
        type: 'ingress',
        sourceSecurityGroupId: cluster.securityGroup,
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
    });

    const zoneCount = envStack.getOutput("AvailabilityZones").apply(zones => zones.length)
    const domain = new aws.opensearch.Domain(name, {
        clusterConfig: {
            instanceType: config.InstanceType,
            instanceCount: zoneCount,
            zoneAwarenessEnabled: true,
            zoneAwarenessConfig: {
                availabilityZoneCount: zoneCount,
            }
        },
        vpcOptions: {
            subnetIds: envStack.getOutput("PrivateSubnetIds"),
            securityGroupIds: [opensearchSecurityGroup.id],
        },
        ebsOptions: {
            ebsEnabled: true,
            volumeSize: 35,
            iops: 1000,
        },
        engineVersion: config.EngineVersion,
    });
    
    const policy = new aws.iam.Policy("opensearch-access", {
        description: "Opensearch Access",
        policy: JSON.stringify(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Action": [
                            "es:*"
                        ],
                        "Effect": "Allow",
                        "Resource": "*"
                    }
                ]
            }        
        )
    })

    cluster.instanceRoles.apply(roles => {
        roles.forEach((role, i) => {
            new aws.iam.RolePolicyAttachment(`opensearch-role-policy-${i}`, { role: role, policyArn: policy.arn })
        })
    })

    const proxyDeployment = new k8s.apps.v1.Deployment("opensearch-proxy", {
        metadata: {
            labels: {
                "app.kubernetes.io/name": "opensearch-proxy",
                "name": "opensearch-proxy",
            }
        },
        spec: {
            replicas: 2,
            selector: {
                matchLabels: {
                    "app.kubernetes.io/name": "opensearch-proxy"
                },
            },
            template: {
                metadata: {
                    labels: {
                        "app.kubernetes.io/name": "opensearch-proxy",
                    },
                },
                spec: {
                    containers: [
                        {
                            image: "public.ecr.aws/aws-observability/aws-sigv4-proxy:latest",
                            imagePullPolicy: "Always",
                            name: "opensearch-proxy",
                            args: [
                                "--verbose",
                                "--log-failed-requests",
                                "--log-signing-process",
                                "--no-verify-ssl",
                                "--name", "es",
                                "--region", aws.getRegion({}).then(region => region.name),
                                "--host", domain.endpoint,
                            ],
                            ports: [
                                {
                                    name: "http",
                                    containerPort: 8080,
                                    protocol: "TCP",
                                }
                            ],
                        },
                    ],
                    restartPolicy: "Always",
                },  
            },
        },
    },
    { provider: cluster.provider })

    const proxyService = new k8s.core.v1.Service("opensearch-proxy", {
        metadata: {
            name: "opensearch-proxy",
            labels: {
                "app.kubernetes.io/name": "opensearch-proxy",
            }
        },
        spec: {
            selector: {
                "app.kubernetes.io/name": "opensearch-proxy",
            },
            ports: [
                {
                    name: "http",
                    port: 80,
                    protocol: "TCP",
                    targetPort: "http",
                }
            ],
        },
    },
    { provider: cluster.provider, dependsOn: [proxyDeployment] });

    return {
        "ENABLE_ES": "true",
        "ES_SCHEMA": "http",
        "ES_SEEDS": pulumi.all([proxyService]).apply(() => "opensearch-proxy.default.svc.cluster.local"),
        "ES_PORT": "80",
    };
};

function createAdvancedVisibility(config: VisibilityConfig, cluster: Cluster): ConfigMapData {
    if (config?.OpenSearch != undefined) {
        return opensearchVisibility("temporal-visibility", config.OpenSearch, cluster)
    }

    return {}
};

function createMonitoring(cluster: Cluster): Monitoring {
    const cloudwatchNamespace = new k8s.core.v1.Namespace("amazon-cloudwatch", { metadata: { name: "amazon-cloudwatch" } }, { provider: cluster.provider })
    const fluentBitConfig = new k8s.core.v1.ConfigMap("fluent-bit-cluster-info",
        {
            metadata: {
                namespace: cloudwatchNamespace.metadata.name,
                name: "fluent-bit-cluster-info"
            },
            data: {
                "cluster.name": cluster.name,
                "http.server": "Off",
                "http.port": "2020",
                "read.head": "Off",
                "read.tail": "On",
                "logs.region": aws.getRegion({}).then(region => region.name),
            }
        },
        { provider: cluster.provider },
    )
    
    cluster.instanceRoles.apply(roles => {
        roles.forEach((role, i) => {
            new aws.iam.RolePolicyAttachment(`cloudwatch-role-policy-${i}`, { role: role, policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy" })
        })
    })
    
    new k8s.yaml.ConfigFile("fluent-bit",
        {
            file: "https://raw.githubusercontent.com/aws-samples/amazon-cloudwatch-container-insights/latest/k8s-deployment-manifest-templates/deployment-mode/daemonset/container-insights-monitoring/fluent-bit/fluent-bit.yaml"
        },
        {
            provider: cluster.provider,
            dependsOn: [fluentBitConfig],
        }
    )
    
    const prometheus = new aws.amp.Workspace("prometheus")

    const workspaceRole = new aws.iam.Role(
        "workspaceRole",
        {
            assumeRolePolicy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Action: "sts:AssumeRole",
                    Effect: "Allow",
                    Sid: "",
                    Principal: {
                        Service: "grafana.amazonaws.com",
                    },
                }],
            })
        }
    );
    const grafana = new aws.grafana.Workspace(
        "grafana",
        {
            accountAccessType: "CURRENT_ACCOUNT",
            authenticationProviders: ["AWS_SSO"],
            permissionType: "SERVICE_MANAGED",
            roleArn: workspaceRole.arn,
        }
    );

    pulumi.all([aws.getRegion({}), prometheus.prometheusEndpoint]).apply(([region, endpoint]) => {
        new k8s.kustomize.Directory("monitoring",
            {
                directory: "../k8s/monitoring",
                transformations: [
                    configureRemoteWrite("k8s", region.name, endpoint),
                ],
            },
            { provider: cluster.provider }
        );
    })

    new aws.iam.RolePolicyAttachment("grafana-prometheus-query-role-policy", { role: workspaceRole, policyArn: "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess" })
    new aws.iam.RolePolicyAttachment("grafana-cloudwatch-role-policy", { role: workspaceRole, policyArn: "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess" })
    new aws.iam.RolePolicyAttachment("grafana-tag-role-policy", { role: workspaceRole, policyArn: "arn:aws:iam::aws:policy/ResourceGroupsandTagEditorReadOnlyAccess" })

    cluster.instanceRoles.apply(roles => {
        roles.forEach((role, i) => {
            new aws.iam.RolePolicyAttachment(`instance-prometheus-remote-write-role-policy-${i}`, { role: role, policyArn: "arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess" })
            new aws.iam.RolePolicyAttachment(`instance-prometheus-query-role-policy-${i}`, { role: role, policyArn: "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess" })
        })
    })

    const apiKey = new aws.grafana.WorkspaceApiKey(
        "external-grafana-editor",
        {
            keyName: "external-grafana-editor",
            keyRole: "ADMIN",
            secondsToLive: 60 * 60 * 24 * 30,
            workspaceId: grafana.id,
        }
    )

    pulumi.all([aws.getRegion({}), grafana.endpoint, prometheus.prometheusEndpoint]).apply(([region, grafanaEndpoint, prometheusEndpoint]) => {
        const dashboards = new k8s.kustomize.Directory("dashboards",
            {
                directory: "../k8s/dashboards",
                transformations: [
                    configureExternalGrafana("external-grafana", grafanaEndpoint),
                    configureAWSDatasource("external-prometheus", region.name, prometheusEndpoint),
                    configureAWSDatasource("cloudwatch", region.name, ""),
                    (obj: any, opts: pulumi.CustomResourceOptions) => {
                        if (obj.kind === "Deployment" && obj.metadata.name === "grafana-operator-controller-manager") {
                            obj.spec.template.spec.containers[0].image = "ghcr.io/grafana-operator/grafana-operator:v5.0.0-rc0"
                        }
                    }
                ]
            },
            { provider: cluster.provider }
        );

        new k8s.core.v1.Secret(
            "external-grafana-apikey",
            {
                metadata: {
                    namespace: "grafana-operator",
                    name: "external-grafana-apikey",
                },
                stringData: {
                    key: apiKey.key,
                }
            },
            { provider: cluster.provider, dependsOn: [dashboards] }
        )    
    })

    return {
        GrafanaEndpoint: grafana.endpoint,
        PrometheusEndpoint: prometheus.prometheusEndpoint,
    };
};

const temporalConfig = config.requireObject<TemporalConfig>('Temporal');
const clusterConfig = config.requireObject<ClusterConfig>('Cluster')
const persistenceConfig = config.requireObject<PersistenceConfig>('Persistence');

const cluster = createCluster(clusterConfig, persistenceConfig);
const persistence = createPersistence(persistenceConfig, cluster);

const temporalNamespace = new k8s.core.v1.Namespace("temporal", { metadata: { name: "temporal" } }, { provider: cluster.provider })

const temporalEnv = new k8s.core.v1.ConfigMap("temporal-env",
    {
        metadata: { name: "temporal-env", namespace: temporalNamespace.metadata.name },
        data: persistence,
    },
    { provider: cluster.provider }
)

const temporalDynamicConfig = new k8s.core.v1.ConfigMap("temporal-dynamic-config",
    {
        metadata: { name: "temporal-dynamic-config", namespace: temporalNamespace.metadata.name },
        data: { "dynamic_config.yaml": dynamicConfig(temporalConfig).apply(config => jsyaml.dump(config)) }
    },
    { provider: cluster.provider }
)

const workerConfig = new k8s.core.v1.ConfigMap("benchmark-worker-env",
    {
        metadata: { name: "benchmark-worker-env" },
        data: {
            "TEMPORAL_WORKFLOW_TASK_POLLERS": temporalConfig.Workers.WorkflowPollers.toString(),
			"TEMPORAL_ACTIVITY_TASK_POLLERS": temporalConfig.Workers.ActivityPollers.toString(),
        }
    },
    { provider: cluster.provider }
)

const soakTestConfig = new k8s.core.v1.ConfigMap("benchmark-soaktest-env",
    {
        metadata: { name: "benchmark-soaktest-env" },
        data: {
            "CONCURRENT_WORKFLOWS": Math.ceil(temporalConfig.SoakTest.ConcurrentWorkflows / temporalConfig.Frontend.Pods).toString(),
        }
    },
    { provider: cluster.provider }
)

const temporalAutoSetup = new k8s.batch.v1.Job("temporal-autosetup",
    {
        metadata: {
            name: "temporal-autosetup",
            namespace: temporalNamespace.metadata.name,
        },
        spec: {
            backoffLimit: 3,
            template: {
                spec: {
                    containers: [
                        {
                            name: "autosetup",
                            image: "temporalio/auto-setup:1.20.0",
                            imagePullPolicy: "IfNotPresent",
                            command: ["/etc/temporal/auto-setup.sh"],
                            envFrom: [
                                {
                                    configMapRef: { name: temporalEnv.metadata.name }
                                }
                            ]
                        }
                    ],
                    restartPolicy: "Never",
                }
            }
        }
    },
    {
        dependsOn: [temporalEnv],
        provider: cluster.provider
    }
)

const configureAWSDatasource = (name: string, region: string, endpoint: string) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "GrafanaDatasource" && obj.metadata.name === name) {
            if (endpoint != "") {
                obj.spec.datasource.url = endpoint
            }
            obj.spec.datasource.jsonData = {
                sigV4Auth: true,
                sigV4AuthType: "ec2_iam_role",
                sigV4Region: region,
            }
        }
    }
}

const configureExternalGrafana = (name: string, endpoint: string) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Grafana" && obj.metadata.name === name) {
            obj.spec.external.url = "https://" + endpoint
        }
    }
}

const configureRemoteWrite = (name: string, region: string, endpoint: string) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Prometheus" && obj.metadata.name === name) {
            obj.spec.replicas = 1
            obj.spec.replicaExternalLabelName = ""
            obj.spec.remoteWrite = [
                {
                    url: endpoint + 'api/v1/remote_write',
                    sigv4: {
                        region: region,
                    },
                    queue_config: {
                        max_samples_per_send: 1000,
                        max_shards: 200,
                        capacity: 2500,
                    },
                    writeRelabelConfigs: [
                        {
                            sourceLabels: ["exported_namespace"],
                            regex: '(.+)',
                            targetLabel: "namespace",
                        },
                        {
                            regex: "exported_namespace",
                            action: "labeldrop",
                        }
                    ],
                }
            ]
        }
    }
}

const scaleDeployment = (name: string, replicas: number) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment" && obj.metadata.name === name) {
            obj.spec.replicas = replicas
        }
    }
}

const setLimits = (name: string, cpu: CPULimits, memory: MemoryLimits) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment" && obj.metadata.name === name) {
            const container = obj.spec.template.spec.containers[0];
            if (cpu?.request) {
                container.resources.requests.cpu = cpu.request
            }
            if (cpu?.limit) {
                container.resources.limits.cpu = cpu.limit;
            }
            if (memory?.request) {
                container.resources.requests.memory = memory.request
            }
            if (memory?.limit) {
                container.resources.limits.memory = memory.limit;
            }
        }
    }
}

const tolerateDedicated = (value: string) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment") {
            obj.spec.template.spec.tolerations = [
                { key: "dedicated", operator: "Equal", value: value, effect: "NoSchedule" }
            ]
        }
    }
}

export const monitoring = createMonitoring(cluster);

new k8s.kustomize.Directory("temporal",
    {
        directory: "../k8s/temporal",
        transformations: [
            scaleDeployment("temporal-frontend", temporalConfig.Frontend.Pods),
            setLimits("temporal-frontend", temporalConfig.Frontend.CPU, temporalConfig.Frontend.Memory),
            scaleDeployment("temporal-history", temporalConfig.History.Pods),
            setLimits("temporal-history", temporalConfig.History.CPU, temporalConfig.History.Memory),
            scaleDeployment("temporal-matching", temporalConfig.Matching.Pods),
            setLimits("temporal-matching", temporalConfig.Matching.CPU, temporalConfig.Matching.Memory),
            tolerateDedicated("temporal"),
        ]
    },
    {
        dependsOn: [temporalNamespace, temporalEnv, temporalDynamicConfig, temporalAutoSetup],
        provider: cluster.provider
    }
);

new k8s.kustomize.Directory("benchmark",
    {
        directory: "../k8s/benchmark",
        transformations: [
            scaleDeployment("benchmark-workers", temporalConfig.Workers.Pods),
            setLimits("benchmark-workers", temporalConfig.Workers.CPU, temporalConfig.Workers.Memory),
            scaleDeployment("benchmark-soak-test", temporalConfig.Frontend.Pods),
        ]
    },
    {
        dependsOn: [temporalAutoSetup, workerConfig, soakTestConfig],
        provider: cluster.provider
    }
);

export const clusterName = cluster.name;
export const kubeconfig = cluster.kubeconfig;
