const process = require('process');
const fs = require('fs');
const { exec } = require('child_process');
const aws = require('aws-sdk');

exec('git pull', [], (err1, stdout1, stderr1) => {
    console.log('pulled');
    exec(`git log -n 1 --pretty=format:"%H"`, [], (err2, stdout2, stderr2) => {
        if (!err2 && !stderr2) {
            const currentCommit = stdout2.trim();
            exec(`electron-builder`, [], (err3, stdout3, stderr3) => {
                console.log('built macos arm');
                exec(`electron-builder --x64`, [], (_err3, _stdout3, _stderr3) => {
                    console.log('built macos x64');
                    exec(`electron-builder --linux --x64`, [], (_err3, _stdout3, _stderr3) => {
                        console.log('built linux x64');
                        exec(`xcrun notarytool submit dist/homegames-1.0.0.dmg --apple-id ${process.env.APPLE_DEVELOPER_ID} --team-id ${process.env.APPLE_TEAM_ID} --password ${process.env.APPLE_PASSWORD} --wait`, [], (_err4, _stdout4, _stderr4) => {
                            console.log('notarized x64');
                                    console.log(_err4);
                                    console.log(_stdout4);
                                    console.log(_stderr4);
 
                            if (!err3) {
                                exec(`xcrun notarytool submit dist/homegames-1.0.0-arm64.dmg --apple-id ${process.env.APPLE_DEVELOPER_ID} --team-id ${process.env.APPLE_TEAM_ID} --password ${process.env.APPLE_PASSWORD} --wait`, [], (err4, stdout4, stderr4) => {
                                    console.log('notarized arm');
                                    console.log(err4);
                                    console.log(stdout4);
                                    console.log(stderr4);
                                    exec('xcrun stapler staple dist/homegames-1.0.0-arm64.dmg ', [], (err5, stdout5, stderr5) => {
                                        console.log('stapled arm');
                                    console.log(err5);
                                    console.log(stdout5);
                                    console.log(stderr5);
 
                                        exec('xcrun stapler staple dist/homegames-1.0.0.dmg ', [], (_err5, _stdout5, _stderr5) => {
                                            console.log('stapled x64. need to upload to s3 and send out sqs message for windows build');
                                        console.log(_err5);
                                        console.log(_stdout5);
                                        console.log(_stderr5);
 
                                            const s3 = new aws.S3();
                                            const armDmg = fs.readFileSync('dist/homegames-1.0.0-arm64.dmg');
                                            const x64Dmg = fs.readFileSync('dist/homegames-1.0.0.dmg');

                                            const armUploadParams = {
                                                Bucket: process.env.BUILD_BUCKET,
                                                Key: `${currentCommit}/homegames-arm64.dmg`,
                                                Body: armDmg
                                            };

                                            const x64UploadParams = {
                                                Bucket: process.env.BUILD_BUCKET,
                                                Key: `${currentCommit}/homegames-x64.dmg`,
                                                Body: x64Dmg
                                            };

                                            const linuxSnapUploadParams = {
                                                Bucket: process.env.BUILD_BUCKET,
                                                Key: `${currentCommit}/homegames-x64.snap`,
                                                Body: x64Dmg  
                                            };

                                            const linuxAppImageUploadParams = {
                                                Bucket: process.env.BUILD_BUCKET,
                                                Key: `${currentCommit}/homegames-x64.AppImage`,
                                                Body: x64Dmg  
                                            };
 
                                            
                                            s3.upload(armUploadParams, function (_err, _data) {
                                                if (_err) {
                                                    console.log("Error", _err);
                                                }
                                                if (_data) {
                                                    console.log("Upload Success", _data.Location);
                                                    s3.upload(x64UploadParams, (uh1, uh2) => {
                                                        if (uh1) {
                                                            console.log('x64 fail' + uh1);
                                                        }
                                                        if (uh2) {
                                                            s3.upload(linuxSnapUploadParams, (_uh1, _uh2) => {
                                                                s3.upload(linuxAppImageUploadParams, (_uh3, _uh4) => {
                                                                    const sqs = new aws.SQS({ region: process.env.SQS_REGION });
                                                                    const messageBody = JSON.stringify({ commit: currentCommit });
                                                                    
                                                                    const sqsParams = {
                                                                        MessageBody: messageBody,
                                                                        QueueUrl: process.env.SQS_QUEUE_URL,
                                                                        MessageGroupId: Date.now() + '',
                                                                        MessageDeduplicationId: Date.now() + ''
                                                                    };
                                                                    
                                                                    sqs.sendMessage(sqsParams, (err, sqsResponse) => {
                                                                        console.log(err);
                                                                        console.log(sqsResponse);
                                                                        if (err) {
                                                                            console.error(err);
                                                                        } else {
                                                                            s3.copyObject({
                                                                                CopySource: `${process.env.BUILD_BUCKET}/${currentCommit}/homegames-arm64.dmg`,
                                                                                Bucket: process.env.BUILD_BUCKET,
                                                                                Key: `stable/homegames-arm64.dmg`
                                                                            }, (e1, e2) => {
                                                                                s3.copyObject({
                                                                                    CopySource: `${process.env.BUILD_BUCKET}/${currentCommit}/homegames-x64.dmg`,
                                                                                    Bucket: process.env.BUILD_BUCKET,
                                                                                    Key: `stable/homegames-x64.dmg` 
                                                                                }, (e3, e4) => {
                                                                                    s3.copyObject({
                                                                                        CopySource: `${process.env.BUILD_BUCKET}/${currentCommit}/homegames-x64.snap`,
                                                                                        Bucket: process.env.BUILD_BUCKET,
                                                                                        Key: `stable/homegames-x64.snap` 
                                                                                    }, (e5, e6) => {
                                                                                        s3.copyObject({
                                                                                            CopySource: `${process.env.BUILD_BUCKET}/${currentCommit}/homegames-x64.AppImage`,
                                                                                            Bucket: process.env.BUILD_BUCKET,
                                                                                            Key: `stable/homegames-x64.AppImage` 
                                                                                        }, (e7, e8) => {
                                                                                            console.log('done!');
                                                                                        });
                                                                                    });
                                                                                });
                                                                            });
                                                                        }
                                                                    });
                                                                });
                                                            });
                                                        }
                                                    });
                                                }
                                            });
                                        });
                                    });
                                });
                            }
                        });
                    });
                });
            });
        }
    });
});
