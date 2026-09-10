# Qawk - QubicaAMF's update server.
#
#   docker build -t qawk:local ota/qawk
#
# Two stages: the Go toolchain builds one static binary, and the image that
# runs it has nothing else in it but a user and a directory for artifacts.
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X qawk/internal/server.Version=${VERSION}" \
      -o /out/qawk ./cmd/qawk

FROM alpine:3.20
# Not root: Qawk opens one port and writes one directory.
RUN adduser -D -u 10001 qawk \
 && mkdir -p /var/lib/qawk/artifacts \
 && chown -R qawk:qawk /var/lib/qawk
COPY --from=build /out/qawk /usr/local/bin/qawk
USER qawk
ENV QAWK_ARTIFACT_DIR=/var/lib/qawk/artifacts
EXPOSE 8080
VOLUME /var/lib/qawk
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/qawk"]
