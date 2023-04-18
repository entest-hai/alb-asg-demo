#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import {
  VpcStack,
  ApplicationStack,
  ImportedVpcStack,
} from "../lib/alb-asg-demo-stack";

const mode = "existedVpc";

const app = new cdk.App();

// ========================= look up existed vpc
if (mode == "existedVpc") {
  const network = new ImportedVpcStack(app, "LookupExistedVpc", {
    vpcName: "VpcForRdsEc2",
    vpcId: "vpc-049d70b38566687a6",
    env: {
      region: "us-east-1",
      account: process.env.CDK_DEFAULT_ACCOUNT,
    },
  });

  new ApplicationStack(app, "ApplicationStack", {
    vpc: network.vpc,
    env: {
      region: "us-east-1",
    },
  });
} else {
  // ========================= new vpc stack
  const network = new VpcStack(app, "VpcStack", {
    cidr: "192.168.0.0/16",
    env: {
      region: "us-east-1",
    },
  });

  // application stack
  const alb = new ApplicationStack(app, "ApplicationStack", {
    vpc: network.vpc,
    env: {
      region: "us-east-1",
    },
  });

  alb.addDependency(network);
}
