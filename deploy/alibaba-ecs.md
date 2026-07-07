# Deploy PR Docket API to Alibaba Cloud ECS

This runbook deploys only the Express backend to an Ubuntu ECS instance using Docker. Keep all secrets in the ECS instance's `.env` file—never in Git.

## 1. Create the ECS instance

- Choose an Ubuntu image with a public IPv4 address.
- A small instance is enough for the hackathon because inference runs in Alibaba Cloud Model Studio.
- In its security group, allow TCP port `22` only from your IP and TCP port `80` from `0.0.0.0/0`.

## 2. Connect and install Docker

Connect using Alibaba Cloud Workbench or SSH, then follow Alibaba Cloud's current Docker-on-ECS instructions. Confirm installation:

```bash
docker --version
```

## 3. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/pr-docket.git
cd pr-docket/server
cp .env.example .env
nano .env
```

Set at least:

```env
QWEN_API_KEY=your_real_key
PORT=3001
GITLAB_TOKEN=
GITLAB_URL=https://gitlab.com
ALLOWED_ORIGINS=http://localhost:5173
```

Replace `ALLOWED_ORIGINS` with the deployed frontend origin when one exists. Multiple origins are comma-separated.

## 4. Build and run

```bash
docker build -t pr-docket-api .
docker run -d \
  --name pr-docket-api \
  --restart unless-stopped \
  --env-file .env \
  -p 80:3001 \
  pr-docket-api
```

## 5. Verify and capture proof

```bash
curl http://localhost/health
docker ps
docker logs pr-docket-api
```

From your own computer, open `http://ECS_PUBLIC_IP/health`. The expected response is `{"status":"ok"}`.

For the hackathon submission, provide the public health URL, the GitHub URL to `server/reviewers.js`, and a screenshot of the ECS console showing the running instance and its public IP.

## Updating the deployment

```bash
git pull
docker build -t pr-docket-api .
docker rm -f pr-docket-api
docker run -d --name pr-docket-api --restart unless-stopped --env-file .env -p 80:3001 pr-docket-api
```
