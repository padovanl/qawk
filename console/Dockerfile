# QubicaAMF - hawkBit console.
#
#   docker build -t qamf-hawkbit-console:local ota/hawkbit-ui/
#
# Runs exactly like hawkbit-simple-ui: its own container on the same network as
# the server, reaching it by the 'hawkbit' network alias.
#
# python:3-alpine and nothing else. The console has no dependencies to install,
# which is the point: no npm, no build step, and once this image is pulled the
# whole thing works on a machine with no internet.
FROM python:3-alpine

WORKDIR /app
COPY serve.py index.html style.css logo.png favicon.png favicon.ico /app/
COPY js/ /app/js/

# Not root. The console reads a handful of files and opens one socket; nothing
# here needs more than that.
RUN adduser -D -u 10001 console && chown -R console:console /app
USER console

ENV HB_URL=http://hawkbit:8080
EXPOSE 8090

# HB_URL is read by serve.py, so the server address can be changed with -e
# without rebuilding.
ENTRYPOINT ["python3", "/app/serve.py", "--port", "8090", "--bind", "0.0.0.0"]
