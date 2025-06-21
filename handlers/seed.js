const axios = require("axios");
const Docker = require("dockerode");
const config = require("../config.json");
const CatLoggr = require("cat-loggr");
const { createVolumesFolder } = require("./init.js");
const log = new CatLoggr();

// Initialize Docker connection
const docker = new Docker({ socketPath: process.env.dockerSocket });

function seed() {
  createVolumesFolder();
}

async function pullImage(image) {
  return new Promise((resolve, reject) => {
    //log.init(`Pulling image ${image}`);
    docker.pull(image, (err, stream) => {
      if (err) {
        //log.error(`Error while pulling ${image}: ${err.message}`);
        return reject(new Error(`Error pulling image: ${err.message}`));
      }

      let progress = 0;

      // Listen for stream events
      stream.on("data", (data) => {
        try {
          const progressData = JSON.parse(data.toString());

          // Check if there's progress info (such as status or progress)
          if (
            progressData.progressDetail &&
            progressData.progressDetail.current
          ) {
            const percent =
              (progressData.progressDetail.current /
                progressData.progressDetail.total) *
              100;
            if (percent > progress) {
              progress = percent;
              //log.info(`Pulling ${image}: ${Math.round(progress)}%`);
            }
          }
        } catch (parseError) {
          //log.error("Error parsing progress data");
        }
      });

      stream.on("end", () => {
        //log.info(`Successfully pulled ${image}`);
        resolve();
      });

      stream.on("error", (error) => {
        //log.error(`Error while pulling ${image}: ${error.message}`);
        reject(new Error(`Error pulling image: ${error.message}`));
      });
    });
  });
}

module.exports = { seed, pullImage };
