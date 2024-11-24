aws s3 cp homegames-arm64.dmg s3://builds.homegames.io/stable/homegames-arm64.dmg

aws cloudfront create-invalidation --distribution-id ${DISTRIBUTION_ID} --paths "/*"
