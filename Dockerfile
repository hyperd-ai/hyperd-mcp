# Dockerfile for Glama MCP registry introspection
#
# This image lets Glama's automated check (https://glama.ai/mcp/servers)
# start the hyperd-mcp server in a clean container and verify it responds
# to MCP introspection requests (list_tools, etc).
#
# It is NOT the recommended way to run hyperd-mcp in production. Production
# users should install via `npx -y hyperd-mcp` with a real
# HYPERD_WALLET_PRIVATE_KEY holding USDC on Base.

FROM node:22-alpine

# Install the latest published hyperd-mcp. Bump version on release if Glama
# refuses to re-fetch the latest npm artifact automatically.
RUN npm install -g hyperd-mcp@1.0.3

# A throwaway private key (the famous test key #1, which derives to address
# 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf with $0 balance). Sufficient for
# the server to construct its EIP-3009 signer and pass introspection. Real
# paid settlements would fail with insufficient-USDC, which is expected here
# — Glama only validates that the MCP server starts and responds to tool
# discovery, not that payments succeed.
ENV HYPERD_WALLET_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001

# stdio transport. Glama wraps the container's stdio in the MCP protocol.
ENTRYPOINT ["hyperd-mcp"]
