aws s3 cp homegames-arm64.dmg s3://builds.homegames.io/stable/homegames-arm64.dmg
aws s3 cp homegames-x64.dmg s3://builds.homegames.io/stable/homegames-x64.dmg
aws s3 cp homegames-x64.snap s3://builds.homegames.io/stable/homegames-x64.snap
aws s3 cp homegames-setup-x64.exe s3://builds.homegames.io/stable/homegames-setup-x64.exe

aws cloudfront create-invalidation --distribution-id ${DISTRIBUTION_ID} --paths "/*"
