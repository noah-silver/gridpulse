# GridPulse MCP server (stdio). Tool calls pay via x402 from EVM_PRIVATE_KEY or ALGORAND_MNEMONIC.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "bin/gridpulse-mcp.mjs"]
