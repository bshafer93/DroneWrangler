import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as s3Deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as events from 'aws-cdk-lib/aws-events'
import * as eventTarget from 'aws-cdk-lib/aws-events-targets'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';

const fs = require('fs');
const path = require('path');
const awsConfig = require('../awsconfig.json');

// eslint-disable-next-line no-underscore-dangle
const root_directory = path.resolve();

export class DroneWranglerStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {

    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this,'devvpc',{
      vpcId: awsConfig.droneWranglerConfig.vpcid
    });

    const userData = fs.readFileSync('./userdata.sh').toString();
    const setupCommands = ec2.UserData.forLinux();
    setupCommands.addCommands(userData);

    const multipartUserData = new ec2.MultipartUserData();
    // The docker has to be configured at early stage, so content type is overridden to boothook
    multipartUserData.addPart(ec2.MultipartBody.fromUserData(setupCommands, 'text/x-shellscript; charset="us-ascii"'));

    const launchTemplate2 = new ec2.LaunchTemplate(this, 'DroneYardLaunchTemplate', {
      launchTemplateName: 'DroneYardLaunchTemplate2',
      userData: multipartUserData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3
          })
        }
      ]
    });

    const dockerRole = new iam.Role(this, 'instance-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Execution role for the docker container, has access to the DroneYard S3 bucket',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role')]
    });




    const awsManagedEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'DroneYardComputeEnvironment', {
      vpc,
      minvCpus: awsConfig.computeEnv.minvCpus,
      maxvCpus: awsConfig.computeEnv.maxvCpus,
      instanceTypes: awsConfig.computeEnv.instanceTypes,
      instanceRole: dockerRole,
      launchTemplate: launchTemplate2,
    });
    

    const jobQueue = new batch.JobQueue(this, 'DroneYardJobQueue', {
      computeEnvironments: [
        {
          computeEnvironment: awsManagedEnvironment,
          order: 1
        }
      ]
    });

    const dockerImage = new DockerImageAsset(this, 'DroneYardDockerImage', {
      directory: path.join(root_directory, "webodm_docker")
    });

    
    const logging = new ecs.AwsLogDriver({ streamPrefix: "dronewranglerruns" })

    const jobDefinition = new batch.EcsJobDefinition(this, 'DroneYardJobDefinition', {
      timeout: cdk.Duration.hours(5),
      container: new batch.EcsEc2ContainerDefinition(this, 'DroneYardContainerDefinition', {
        command: [
          'sh',
          '-c',
          '/entry.sh',
          'Ref::bucket',
          'Ref::key',
          'output',
        ],
        gpu: 0,
        image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
        memory: cdk.Size.gibibytes(480),
        cpu: 16,
        privileged: true,
        volumes: [batch.EcsVolume.host({
          name: 'local',
          containerPath: '/local'
        })],
        logging: logging
      })
    });

    const dispatchLambdaRole = new iam.Role(this, 'dispatch-lambda-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    })

    dispatchLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
    dispatchLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"));
    dispatchLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBatchFullAccess"));

    //Lambda For Zipping and Emailing

    const zipandsendLambdaRole = new iam.Role(this, 'zip-and-send-lambda-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    })

    zipandsendLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
    zipandsendLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"));
    zipandsendLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSESFullAccess"));
    zipandsendLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBatchFullAccess"));

    const dispatchFunction = new lambda.Function(this, 'DispatchHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/dispatch-handler'),
      role: dispatchLambdaRole,
      environment: {
        JOB_DEFINITION: jobDefinition.jobDefinitionName,
        JOB_QUEUE: jobQueue.jobQueueName
      }
    })

    const sendstatusFunction = new lambda.Function(this, 'SendStatusHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/send-status'),
      role: zipandsendLambdaRole,
      environment: {
        JOB_DEFINITION: jobDefinition.jobDefinitionName,
        JOB_QUEUE: jobQueue.jobQueueName
      }
    })

    const sendzipFunction = new lambda.Function(this, 'sendzipHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromAsset('functions/send-zip'),
      role: zipandsendLambdaRole,
      environment: {
      }
    })

    //Get the bucket for all user's data. 
    const dronePhotosBucket = s3.Bucket.fromBucketAttributes(this,"ImportedPhotosBucket",{
      bucketArn:awsConfig.droneWranglerConfig.bucketArnToSearchForImages,
    });
    dronePhotosBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(dispatchFunction), {suffix: 'dispatch'});
    dronePhotosBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(sendzipFunction), {suffix: 'odmoutput.zip'});
    dronePhotosBucket.grantReadWrite(dockerRole);
    dronePhotosBucket.grantReadWrite(zipandsendLambdaRole);

    const event = new events.Rule(this, 'NotificationRule', {
      ruleName: 'DroneYardNotificationRule',
      eventPattern: {
        source: ['aws.batch'],
        detailType: ['Batch Job State Change'],
        detail: {
          parameters: {
            bucket: [premadePhotoBucket.bucketName]
          },
          status: ["FAILED","STARTING","SUBMITTED","SUCCEEDED"]
        }
      }
    });

    event.addTarget(new eventTarget.LambdaFunction(sendstatusFunction));

    /*
    new s3Deploy.BucketDeployment(this, 'settings yaml', {
      sources: [s3Deploy.Source.asset(root_directory, { exclude: ['**', '.*', '!settings.yaml'] })],
      destinationBucket: premadePhotoBucket
    });
    */
  }
}


