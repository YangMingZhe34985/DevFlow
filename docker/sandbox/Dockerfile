FROM node:24-bookworm-slim

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin devflow

WORKDIR /workspace
RUN chown devflow:devflow /workspace

USER devflow

# The future sandbox manager creates one container per Run, copies/clones a
# repository into /workspace and invokes structured commands with docker exec.
CMD ["sleep", "infinity"]
