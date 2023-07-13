# Benchmark stacks

These stacks build Temporal clusters ready for running benchmarks on. For this first stage only EKS clusters using RDS are supported.

## Deployment

Before deploying a stack you will need to have an AWS environment stack deployed. Please see the [AWS Environment stack](../environment/aws/README.md).

Once the environment stack is deployed, unless you are a Temporal employee you will need to adjust the `EnvironmentStackName` config value in the stack you wish to deploy to point to your environment stack rather than `temporalio/temporal-benchmarks-aws-environment/main` that we use for our CI.

If you'd like to replicate one of our existing benchmarks, that is all you should need to adjust. You can then bring up the stack with `pulumi -s <stack name> up`.

Create role `BenchmarkClusterAdmin` with admin capabilities.

For example, to bring up an EKS cluster with Temporal running against an RDS postgres m6i.2xlarge instance you can use our existing stack configuration with:

```shell
$ export PULUMI_CONFIG_PASSPHRASE=""

$ pulumi -s YOUR_STACK up

$ source ./fetch-kubeconfig YOUR_STACK

# NOTE: doesn't set AWS profile of used. Need to fix by adding this to the $KUBECONFIG file
#   env:
#      - name: AWS_PROFILE
#        value: staging
```

- changing values need restart soak test -> no config map hashes
