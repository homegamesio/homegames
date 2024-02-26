const process = require('process');
const fs = require('fs');
const { exec } = require('child_process');
const aws = require('aws-sdk');

exec('git pull', [], (err1, stdout1, stderr1) => {
    exec(`git log -n 1 --pretty=format:"%H"`, [], (err2, stdout2, stderr2) => {
        const currentCommit = stdout2.trim();
        const params = {
          QueueUrl: process.env.SQS_QUEUE_URL,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 60,
        };


        const sqs = new aws.SQS({ region: process.env.SQS_REGION });
        sqs.receiveMessage(params, (err, data) => {
            console.log("!!!!!!");
            console.log(err);
            console.log(data);
            if (!err && data?.Messages?.length) {
                const payload = JSON.parse(data.Messages[0].Body);  
                if (payload.commit === currentCommit) {
                    exec(`electron-builder `, [], (_err3, _stdout3, _stderr3) => {
                        console.log('built!');
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
            }
        });
    });
});
