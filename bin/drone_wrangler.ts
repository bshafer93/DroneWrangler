#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DroneWranglerStack } from '../lib/drone_wrangler_stack';

const app = new cdk.App();
new DroneWranglerStack(app, 'DroneWranglerStack', {
    env:{
        account: process.env.CDK_DEFAULT_ACCOUNT, 
        region: process.env.CDK_DEFAULT_REGION
   } 
});