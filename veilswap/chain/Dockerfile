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

COPY contracts ./contracts
COPY chain/start.sh ./start.sh

USER root
RUN chmod +x ./start.sh

EXPOSE 8545
CMD ["./start.sh"]
