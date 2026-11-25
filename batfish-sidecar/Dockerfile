# Optional sidecar for scenario 7 (compose profile "batfish"): Batfish + a tiny HTTP wrapper around pybatfish.
FROM batfish/allinone
COPY server.py /app/server.py
EXPOSE 5005
# Start the Batfish service (same command as the image's wrapper.sh, without Jupyter), wait for it, then serve the wrapper.
ENTRYPOINT ["bash", "-c", "java -XX:-UseCompressedOops -XX:+UseContainerSupport -XX:MaxRAMPercentage=80 -Dlog4j.configurationFile=log4j2.yaml -cp allinone-bundle.jar org.batfish.allinone.Main -runclient false -loglevel warn -coordinatorargs '-templatedirs questions -containerslocation /data/containers' & until (echo > /dev/tcp/localhost/9996) 2>/dev/null; do sleep 1; done; exec python3 /app/server.py"]
