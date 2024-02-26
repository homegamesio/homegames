const process = require('process');
const fs = require('fs');
const { exec } = require('child_process');
const aws = require('aws-sdk');

const sqs = new aws.SQS({ region: process.env.SQS_REGION });
const params = {
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: 1,
    VisibilityTimeout: 60,
};

setInterval(() => {
    sqs.receiveMessage(params, (err, data) => {
        const payload = JSON.parse(data.Messages[0].Body);  
        if (!err && data?.Messages?.length) {
            exec('git pull', [], (err1, stdout1, stderr1) => {
                exec(`git log -n 1 --pretty=format:"%H"`, [], (err2, stdout2, stderr2) => {
                    const currentCommit = stdout2.trim();
                    
                    if (payload.commit === currentCommit) {
                        exec(`electron-builder `, [], (_err3, _stdout3, _stderr3) => {
                            const s3 = new aws.S3();
                            const exe = fs.readFileSync('dist/homegames Setup 1.0.0.exe');
                            console.log('built!');
                            const uploadParams = {
                                Bucket: 'builds.homegames.io',
                                Key: `${currentCommit}/homegames-setup-x64.exe`,
                                Body: exe
                            };
    
                            s3.upload(uploadParams, function (_err, _data) {
                                s3.copyObject({
                                    CopySource: `${process.env.BUILD_BUCKET}/${currentCommit}/homegames-setup-x64.exe`,
                                    Bucket: process.env.BUILD_BUCKET,
                                    Key: `stable/homegames-setup-x64.exe`
                                }, (e1, e2) => {
                                    console.log('alright');             
                                });
                            });
                        });
                    } else {
                        console.warn(`Not building: commit mismatch ${payload.commit} and ${currentCommit}`);
    
                    }
                    console.log('compare ' + currentCommit);
                    console.log(payload);
                    const deleteParams = {
                        QueueUrl: params.QueueUrl,
                        ReceiptHandle: data.Messages[0].ReceiptHandle,
                    };
    
                    sqs.deleteMessage(deleteParams, (err, data) => {
                        console.log(err);
                        console.log(data);
                        console.log("deleted");
                    });
     
    //                    console.log("built!");
    //                });
                });
            });
        }
    });
}, 60 * 1000);
