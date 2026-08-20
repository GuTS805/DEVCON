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

# Deploy.s.sol writes its address manifest to contracts/deployments/, which is
# gitignored and therefore absent from the build context. vm.writeJson reverts on
# a missing directory, which fails the whole script before anything broadcasts.
RUN mkdir -p contracts/deployments

# Compile here rather than on boot. This downloads solc while the image is being
# built, where a failure is visible in the build log, instead of at start-up
# where it would just look like a crash.
RUN cd contracts && forge build

# The base image sets its own entrypoint; clear it so the command below is what
# actually runs, and invoke sh explicitly rather than relying on the shebang.
ENTRYPOINT []
EXPOSE 8545
CMD ["/bin/sh", "/app/start.sh"]
