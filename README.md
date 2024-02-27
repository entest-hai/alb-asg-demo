---
title: Application Load Balancer and Auto Scaling Group
description: a simple alb and asg web application
author: haimtran
publishedDate: 06/07/2023
date: 2023-07-06
---

## Introduction

This [GitHub](https://github.com/cdk-entest/alb-asg-demo) show a simple architecture with load balancer, autoscaling group, and a webserver with userdata

- Create a VPC
- Create a application load balancer
- Create an autoscaling group (asg) 2-2-2
- Add userData to run a web
- Terminate an EC2 and see (asg) launch a new EC2

![Untitled Diagram drawio](https://user-images.githubusercontent.com/20411077/202885587-6bc6bd59-5a85-49e6-a1ff-808d40665def.png)

## Network Stack

```tsx
export class VpcStack extends Stack {
  public readonly vpc: aws_ec2.Vpc;

  constructor(scope: Construct, id: string, props: VpcProps) {
    super(scope, id, props);

    this.vpc = new aws_ec2.Vpc(this, "VpcAlbDemo", {
      vpcName: "VpcAlbDemo",
      cidr: props.cidr,
      subnetConfiguration: [
        {
          name: "Public",
          cidrMask: 24,
          subnetType: aws_ec2.SubnetType.PUBLIC,
        },
        {
          name: "PrivateWithNat",
          cidrMask: 24,
          subnetType: aws_ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          name: "PrivateWoNat",
          cidrMask: 24,
          subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
  }
}
```

look up for an existed vpc

```ts
interface ImportedVpcProps extends StackProps {
  vpcId: string;
  vpcName: string;
}

export class ImportedVpcStack extends Stack {
  public readonly vpc: aws_ec2.IVpc;

  constructor(scope: Construct, id: string, props: ImportedVpcProps) {
    super(scope, id, props);

    this.vpc = aws_ec2.Vpc.fromLookup(this, "LookupExistedVpc", {
      vpcId: props.vpcId,
      vpcName: props.vpcName,
    });
  }
}
```

## Application Load Balancer

security group for alb

```tsx
const albSecurityGroup = new aws_ec2.SecurityGroup(this, "SGForWeb", {
  securityGroupName: "SGForWeb",
  vpc: vpc,
});

albSecurityGroup.addIngressRule(
  aws_ec2.Peer.anyIpv4(),
  aws_ec2.Port.tcp(80),
  "Allow port 80 web"
);
```

application load balancer

```tsx
const alb = new aws_elasticloadbalancingv2.ApplicationLoadBalancer(
  this,
  "AlbWebDemo",
  {
    vpc: vpc,
    loadBalancerName: "AlbWebDemo",
    vpcSubnets: {
      subnetType: aws_ec2.SubnetType.PUBLIC,
    },
    internetFacing: true,
    deletionProtection: false,
    securityGroup: albSecurityGroup,
  }
);
```

add listener port 80

```tsx
const listener = alb.addListener("AlbListener", {
  port: 80,
});
```

## Auto Scaling Group

security group for auto scaling group

```tsx
const asgSecurityGroup = new aws_ec2.SecurityGroup(this, "SGForASG", {
  securityGroupName: "SGForASG",
  vpc: props.vpc,
});

asgSecurityGroup.addIngressRule(
  aws_ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
  aws_ec2.Port.tcp(80)
);
```

auto scaling group

```tsx
const asg = new aws_autoscaling.AutoScalingGroup(this, "AsgDemo", {
  autoScalingGroupName: "AsgWebDemo",
  vpc: vpc,
  instanceType: aws_ec2.InstanceType.of(
    aws_ec2.InstanceClass.T2,
    aws_ec2.InstanceSize.SMALL
  ),
  machineImage: aws_ec2.MachineImage.latestAmazonLinux2023({
    cachedInContext: true,
  }),
  minCapacity: 2,
  maxCapacity: 2,
  vpcSubnets: {
    subnets: vpc.privateSubnets,
  },
  role: role,
  securityGroup: asgSecurityGroup,
});
```

asg user data - download and run webserver

```tsx
asg.addUserData(fs.readFileSync("./lib/script/user-data.sh", "utf8"));
```

## ALB Listener

an implicit target group created

```tsx
listener.addTargets("Target", {
  port: 80,
  targets: [asg],
  healthCheck: {
    path: "/",
    port: "80",
    protocol: aws_elasticloadbalancingv2.Protocol.HTTP,
    healthyThresholdCount: 5,
    unhealthyThresholdCount: 2,
    timeout: Duration.seconds(10),
  },
});
```

## Scaling Policy

target tracking - on cpu usage

```tsx
asg.scaleOnCpuUtilization("KeepSparseCPU", {
  targetUtilizationPercent: 50,
});
```

target tracking - on number of request per instance

```tsx
asg.scaleOnRequestCount("AvgReqeustPerInstance", {
  targetRequestsPerMinute: 1000,
});
```

step scale - based on custom metric

```tsx
const metric = new aws_cloudwatch.Metric({
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  statistic: "Average",
  period: Duration.minutes(1),
  dimensionsMap: {
    AutoScalingGroupName: asg.autoScalingGroupName,
  },
});
```

scale on custom metric with custom step

```tsx
asg.scaleOnMetric("MyMetric", {
  metric: metric,
  scalingSteps: [
    {
      upper: 1,
      change: -1,
    },
    {
      lower: 10,
      change: +1,
    },
    {
      lower: 60,
      change: +3,
    },
  ],
  adjustmentType: aws_autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
});
```

## Bedrock

Let update the instance role so it can call Bedorck

```ts
role.addToPolicy(
  new aws_iam.PolicyStatement({
    effect: Effect.ALLOW,
    resources: [
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2",
      "arn:aws:bedrock:us-east-1::foundation-model/stability.stable-diffusion-xl-v1",
    ],
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  })
);

// allow push and pull ecr
role.addManagedPolicy(
  aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
    "AmazonEC2ContainerRegistryReadOnly"
  )
);
```

And user-data-bedrock here

<details>
<summary>user-data-bedorkc.sh</summary>

```txt
#!/bin/bash
# export account id
export ACCOUNT_ID=111222333444
# export region
export REGION=us-east-1
# install docker
yes | dnf install docker
# start docker
systemctl start docker
# kill running containers
# docker kill $(docker ps -q)
# delete all existing images
# yes | docker system prune -a
# auth ecr
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
# pull and run
docker pull $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/next-bedrock:latest
# run docker image
docker run -d -p 80:3000 $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/next-bedrock:latest
# debug
# sudo docker exec -it sad_hellman /bin/bash
# sudo docker exec -it sad_hellman /bin/sh
# sudo docker run -d -p 3000:3000 $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/next-bedrock:latest
```

<details>

## HTTPS

- create ACM certificate
- add listener https on alb
- create a record on route53

```ts
const listenerHTTPS = alb.addListener("AlbListenerHTTPS", {
  port: 443,
  open: true,
  protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
  certificates: [
    ListenerCertificate.fromArn(props.acmCertArn ? props.acmCertArn : ""),
  ],
});

listenerHTTPS.addTargets("TargetHTTPS", {
  port: 80,
  targets: [asg],
  healthCheck: {
    path: "/",
    port: "80",
    protocol: aws_elasticloadbalancingv2.Protocol.HTTP,
    healthyThresholdCount: 5,
    unhealthyThresholdCount: 2,
    timeout: Duration.seconds(10),
  },
});
```

Script to update route53 record

```py

import os
import boto3

# change to entest account
os.system("set-aws-account.sh entest ap-southeast-1")

# route53 client
client = boto3.client('route53')

# update load balancer dns
response = client.change_resource_record_sets(
    ChangeBatch={
        'Changes': [
            {
                'Action': 'UPSERT',
                'ResourceRecordSet': {
                    'Name': 'image-vng.entest.io',
                    'ResourceRecords': [
                        {
                            'Value': $ALB_ENDPOINT,
                        },
                    ],
                    'TTL': 300,
                    'Type': 'CNAME',
                },
            },
        ],
        'Comment': 'Web Server',
    },
    HostedZoneId=$HOSTED_ZONE_ID,
)

print(response)

# change back to demo account
os.system("set-aws-account.sh demo us-east-1")
```

## Load Test

Option 1. manually terminal EC2 instances
Option 2. send concurrent requests

```py
import time
import requests
from concurrent.futures import ThreadPoolExecutor

URL = "http://$ALB_URL"
NO_CONCUR_REQUEST = 1000
COUNT = 1


def send_request():
    resp = requests.get(URL)
    # print(resp)


def test_concurrent():
    with ThreadPoolExecutor(max_workers=NO_CONCUR_REQUEST) as executor:
        for k in range(1, NO_CONCUR_REQUEST):
            executor.submit(send_request)


while True:
    print(f"{NO_CONCUR_REQUEST} requests {COUNT}")
    test_concurrent()
    time.sleep(1)
    COUNT += 1
```

## User Data

user-data-1

```bash
#!/bin/bash
cd ~
wget https://github.com/cdk-entest/alb-asg-demo/archive/refs/heads/main.zip
unzip main.zip
cd alb-asg-demo-main
cd web
python3 -m pip install -r requirements.txt
python3 -m app
```

user-data-2

```bash
#!/bin/bash
cd ~
wget https://github.com/cdk-entest/eks-cdk-web/archive/refs/heads/master.zip
unzip master.zip
cd eks-cdk-web-master/webapp
python3 -m ensurepip --upgrade
python3 -m pip install -r requirements.txt
python3 -m app
```

user-data-3

```bash
#!/bin/bash
# # kill -9 $(lsof -t -i:8080)
cd ~
# download vim configuration
wget -O ~/.vimrc https://raw.githubusercontent.com/cdk-entest/basic-vim/main/.vimrc
# download web app
wget https://github.com/cdk-entest/flask-tailwind-polly/archive/refs/heads/master.zip
unzip master.zip
cd flask-tailwind-polly-master
# install pip
python3 -m ensurepip --upgrade
# install dependencies
python3 -m pip install -r requirements.txt
cd app
# export bucket name for polly app
export BUCKET_NAME="nicv-demo-02112023"
# export region for polly app
export REGION="ap-southeast-1"
python3 -m app
```

## Troubleshooting

Run container locall and test

```bash
sudo docker run -d -p 3000:3000 next-diffusion-app:latest
```

Kill all containers are running

```bash
docker kill $(docker ps -q)
```

Find process runing on port and kill

```bash
kill -9 $(lsof -t -i:8080)
```

Or use this command

```bash
netstat -nlp|grep 9000
```

Exec into a docker container running

```bash
docker ps
docker exec -it container-name /bin/sh
```

Dockerfile node16

```ts
FROM node:16-alpine AS deps
# FROM public.ecr.aws/docker/library/node:16-alpine

RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then yarn global add pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi

FROM node:16-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

FROM node:16-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT 3000
CMD ["node", "server.js"]

```

## Reference

- [cooldown and warmup time](https://docs.aws.amazon.com/autoscaling/ec2/userguide/consolidated-view-of-warm-up-and-cooldown-settings.html)

- [target group](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html)

- [weighted target group](https://aws.amazon.com/blogs/aws/new-application-load-balancer-simplifies-deployment-with-weighted-target-groups/)

```

```
