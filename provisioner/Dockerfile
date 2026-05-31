# Provisioner: tiny Node/Express + htmx app that drives kubectl against AKS.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
ARG KUBECTL_VERSION=v1.34.7
RUN apk add --no-cache curl ca-certificates \
 && arch="$(uname -m)" \
 && case "$arch" in x86_64) k="amd64";; aarch64) k="arm64";; *) k="amd64";; esac \
 && curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${k}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Non-root (Kyverno-compliant when run on the cluster). KUBECONFIG is mounted at runtime.
USER 1000
CMD ["node", "src/server.js"]
