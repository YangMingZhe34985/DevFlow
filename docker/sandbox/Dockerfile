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

# The sandbox manager uses this image for isolated workflow and autonomous Runs,
# copies/clones repositories into /workspace and runs commands with docker exec.
CMD ["sleep", "infinity"]
