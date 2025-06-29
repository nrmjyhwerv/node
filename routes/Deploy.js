const express = require("express");
const router = express.Router();
const Docker = require("dockerode");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const https = require("https");
const { pullImage } = require("../handlers/seed");
const { pipeline } = require("stream/promises");
const statedirectory = path.resolve(__dirname, "../states.json");
const docker = new Docker({ socketPath: process.env.dockerSocket });

async function setStateValue(id, state) {
  const data = JSON.parse(await fs.readFile(statedirectory, "utf-8"));

  // Find the item with the matching ID
  const item = data.find((entry) => entry.Id === id);

  if (!item) {
    return `ID ${id} not found.`;
  }

  // Update the state
  item.State = state;

  // Write the updated data back to the file
  await fs.writeFile(statedirectory, JSON.stringify(data, null, 2));
}

async function setState(id, state) {
  try {
    // Check if the states.json file exists
    if (!fsSync.existsSync(statedirectory)) {
      // If not, create the file with an empty array
      await fs.writeFile(statedirectory, JSON.stringify([], null, 2));
    }

    // Read the existing data from the file
    const data = JSON.parse(await fs.readFile(statedirectory, "utf-8"));

    // Add the new state object to the array
    data.push({ Id: id, State: state });

    // Write the updated data back to the file
    await fs.writeFile(statedirectory, JSON.stringify(data, null, 2));
    //log.info("State added successfully for " + id);
  } catch (error) {
    //log.info("Error setting state:", error);
    throw error;
  }
}

const downloadFile = (url, dir, filename) => {
  return new Promise((resolve, reject) => {
    const filePath = path.join(dir, filename);
    https
      .get(url, async (response) => {
        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Failed to download ${filename}: HTTP status code ${response.statusCode}`
            )
          );
          return;
        }
        const writeStream = fsSync.createWriteStream(filePath);
        try {
          await pipeline(response, writeStream);
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        fsSync.unlink(filePath, () => {});
        reject(err);
      });
  });
};

const downloadInstallScripts = async (installScripts, dir, variables) => {
  try {
    const parsedVariables =
      typeof variables === "string" ? JSON.parse(variables) : variables;

    for (const script of installScripts) {
      try {
        let updatedUri = script.Uri;

        if (parsedVariables) {
          for (const [key, value] of Object.entries(parsedVariables)) {
            updatedUri = updatedUri.replace(
              new RegExp(`{{${key}}}`, "g"),
              value
            );
            //log.info(`Replaced ${key} with ${value} in ${updatedUri}`);
          }
        }

        await downloadFile(updatedUri, dir, script.Path);
        //log.info(`Successfully downloaded ${script.Path}`);
      } catch (err) {
        //log.error(`Failed to download ${script.Path}: ${err.message}`);
      }
    }
  } catch (err) {
    //log.error(`Error in downloadInstallScripts: ${err.message}`);
    throw err;
  }
};

const replaceVariables = async (dir, variables) => {
  const files = await fs.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = await fs.stat(filePath);
    if (stats.isFile() && !file.endsWith(".jar")) {
      let content = await fs.readFile(filePath, "utf8");
      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        content = content.replace(regex, value);
      }
      await fs.writeFile(filePath, content, "utf8");
      //log.info(`Variables replaced in ${file}`);
    }
  }
};

router.get("/:id/states/set/:state", async (req, res) => {
  const { id, state } = req.params;

  try {
    await setStateValue(id, state);
    res.json({ success: true, message: `State updated for ID ${id}` });
  } catch (error) {
    //console.error("Error updating state:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id/states/get", async (req, res) => {
  const { id } = req.params;
  try {
    // Read the existing data
    const data = JSON.parse(await fs.readFile(statedirectory, "utf-8"));

    // Find the item with the matching ID
    const item = data.find((entry) => entry.Id === id);

    if (!item) {
      return res.status(404).json({ error: `ID ${id} not found.` });
    }

    // Update the state
    const showState = item.State;
    res.json({ success: true, state: showState });
  } catch (error) {
    //console.error("Error updating state:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
router.post("/create", async (req, res) => {
  //log.info("Deployment in progress...");
  const { Image, Id, Cmd, Env, Ports, Scripts, Memory, Cpu, PortBindings } =
    req.body;
  const variables2 = req.body.variables;

  try {
    await pullImage(Image);
    const volumePath = path.join(__dirname, "../volumes", Id);
    await fs.mkdir(volumePath, { recursive: true });
    const primaryPort = Object.values(PortBindings)[0][0].HostPort;

    function objectToEnv(obj) {
      return Object.entries(obj).map(([key, value]) => `${key}=${value}`);
    }
    const variables2Env = objectToEnv(JSON.parse(variables2));

    const environmentVariables = [
      ...(Env || []),
      ...variables2Env,
      `PRIMARY_PORT=${primaryPort}`,
      `INSTANCE_MEMORY=${Memory}`,
      `INSTANCE_CPU=${Cpu}`,
      `INSTANCE_ID=${Id}`,
    ];
    const containerOptions = {
      name: Id,
      Image,
      ExposedPorts: Ports,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        PortBindings: PortBindings,
        Binds: [`${volumePath}:/app/data`],
        Memory: Memory * 1024 * 1024,
        CpuCount: Cpu,
        NetworkMode: "host",
      },
      Env: environmentVariables,
    };

    if (Cmd) containerOptions.Cmd = Cmd;

    const container = await docker.createContainer(containerOptions);
    const state = await setState(Id, "INSTALLING");
    //log.info("Deployment completed! Container: " + container.id);
    res.status(201).json({
      message: "Container and volume created successfully",
      containerId: container.id,
      volumeId: Id,
      state: "INSTALLING",
      Env: environmentVariables,
    });

    if (Scripts && Scripts.Install && Array.isArray(Scripts.Install)) {
      const dir = path.join(__dirname, "../volumes", Id);
      await downloadInstallScripts(Scripts.Install, dir, variables2);

      const variables = {
        primaryPort: primaryPort,
        containerName: container.id.substring(0, 12),
        timestamp: new Date().toISOString(),
        randomString: Math.random().toString(36).substring(7),
      };

      await replaceVariables(dir, variables);
    }
    await setStateValue(Id, "READY");
    await container.start();
  } catch (err) {
    log.error("Deployment failed: " + err.message);
     await setStateValue(Id, "FAILED");
    res.status(500).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const container = docker.getContainer(req.params.id);
  try {
    await container.remove();
    res.status(200).json({ message: "Container removed successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/redeploy/:id", async (req, res) => {
  const { id } = req.params;
  const container = docker.getContainer(id);
  try {
    await container.remove();

    const { Image, Id, Ports, Memory, Cpu, PortBindings, Env } = req.body;
    const volumePath = path.join(__dirname, "../volumes", Id);

    const containerOptions = {
      Image,
      ExposedPorts: Ports,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        PortBindings: PortBindings,
        Binds: [`${volumePath}:/app/data`],
        Memory: Memory * 1024 * 1024,
        CpuCount: Cpu,
        NetworkMode: "host",
      },
      Env: Env,
    };

    const newContainer = await docker.createContainer(containerOptions);
    await newContainer.start();
    res.status(200).json({
      message: "Container redeployed successfully",
      containerId: newContainer.id,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/reinstall/:id", async (req, res) => {
  const { id } = req.params;
  const container = docker.getContainer(id);

  try {
    const containerInfo = await container.inspect();
    if (containerInfo.State.Running) {
      //log.info(`Stopping container ${id}`);
      await container.stop();
    }
    //log.info(`Removing container ${id}`);
    await container.remove();

    function env2json(env) {
      //log.info("env2json", env);
      return env.reduce((obj, item) => {
        const [key, value] = item.split("=");
        obj[key] = value;
        return obj;
      }, {});
    }

    const { Image, Id, Ports, Memory, Cpu, PortBindings, Env, imageData } =
      req.body;
    const volumePath = path.join(__dirname, "../volumes", Id);

    const containerOptions = {
      Image,
      ExposedPorts: Ports,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        PortBindings: PortBindings,
        Binds: [`${volumePath}:/app/data`],
        Memory: Memory * 1024 * 1024,
        CpuCount: Cpu,
        NetworkMode: "host",
      },
      Env: Env,
    };

    const newContainer = await docker.createContainer(containerOptions);

    if (
      imageData &&
      imageData.Scripts &&
      imageData.Scripts.Install &&
      Array.isArray(imageData.Scripts.Install)
    ) {
      const dir = path.join(__dirname, "../volumes", Id);

      await downloadInstallScripts(
        imageData.Scripts.Install,
        dir,
        env2json(Env)
      );

      const variables = {
        primaryPort: Object.values(PortBindings)[0][0].HostPort,
        containerName: newContainer.id.substring(0, 12),
        timestamp: new Date().toISOString(),
        randomString: Math.random().toString(36).substring(7),
      };
      const envVariables = Object.fromEntries(Env.map((e) => e.split("=")));
      await replaceVariables(dir, variables);
    }
    await newContainer.start();
    res.status(200).json({
      message: "Container reinstalled successfully",
      containerId: newContainer.id,
    });
  } catch (err) {
    log.error("Error reinstalling instance:", err);
    res.status(500).json({ message: err.message });
  }
});

router.put("/edit/:id", async (req, res) => {
  const { id } = req.params;
  const { Image, Memory, Cpu, VolumeId } = req.body;

  try {
    //log.info(`Editing container: ${id}`);
    const container = docker.getContainer(id);
    const containerInfo = await container.inspect();
    const existingConfig = containerInfo.Config;
    const existingHostConfig = containerInfo.HostConfig;
    const newContainerOptions = {
      Image: Image || existingConfig.Image,
      ExposedPorts: existingConfig.ExposedPorts,
      Cmd: existingConfig.Cmd,
      Env: existingConfig.Env,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        PortBindings: existingHostConfig.PortBindings,
        Binds: [`${path.join(__dirname, "../volumes", VolumeId)}:/app/data`], 
        Memory: Memory ? Memory * 1024 * 1024 : existingHostConfig.Memory,
        CpuCount: Cpu || existingHostConfig.CpuCount,
        NetworkMode: "host",
      },
    };
    //log.info(`Stopping container: ${id}`);
    await container.stop();
    //log.info(`Removing container: ${id}`);
    await container.remove();
    //log.info("Creating new container with updated configuration");
    const newContainer = await docker.createContainer(newContainerOptions);
    await newContainer.start();

    //log.info(`Edit completed! New container ID: ${newContainer.id}`);
    res.status(200).json({
      message: "Container edited successfully",
      oldContainerId: id,
      newContainerId: newContainer.id,
    });
  } catch (err) {
    //log.error(`Edit failed: ${err.message}`);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
