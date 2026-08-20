# A disposable Anvil chain with the VeilSwap contracts already deployed.
#
# The demo needs things a public testnet will not give it: instant blocks, four
# funded signers, and evm_revert so every run starts from the same pool. So the
# hosted version is the same local chain, put behind a URL.
#
# Nothing here holds value. The keys are Anvil's published test accounts and the
# chain is wiped on every restart.
FROM ghcr.io/foundry-rs/foundry:latest

WORKDIR /app

# Paths are relative to the repository root, which is the build context, so the
# host needs no root-directory setting of its own.
COPY veilswap/contracts ./contracts
COPY veilswap/chain/start.sh ./start.sh

USER root
RUN chmod +x ./start.sh

# The base image sets its own entrypoint; clear it so the command below is what
# actually runs, and invoke sh explicitly rather than relying on the shebang.
ENTRYPOINT []
EXPOSE 8545
CMD ["/bin/sh", "/app/start.sh"]
