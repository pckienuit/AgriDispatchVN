FROM mcr.microsoft.com/azure-functions/node:4-node24
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=node
WORKDIR /home/site/wwwroot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && node -e "require('sharp')"
COPY functions/host.json ./host.json
COPY functions/thumbnail/function.json ./thumbnail/function.json
COPY functions/thumbnail ./functions/thumbnail
COPY server/src/evidence-image.js server/src/blob-store.js ./server/src/
