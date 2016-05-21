/**
 * Created by Mikk on 4.05.2016.
 */
"use strict";

require("console-stamp")(console, {
  pattern: "d dddd HH:MM:ss.l"
});
const express = require("express");
const http = require("https");
const fs = require("fs-extra");
const jsonFile = require("jsonfile");
const schedule = require("node-schedule");
const morgan = require('morgan');

class Server {
  constructor() {
    Server.checkCacheFolder();

    this.config = Server.loadConfig();

    this.expressServer = express();
    this.expressServer.use(morgan(":date[iso] :remote-addr :method :url :status :res[content-length]"));

    this.cronJob = schedule.scheduleJob("*/30 * * * *", Server.updateCacheFiles);

    //Server.updateCacheFiles();
  }

  /**
   * Ensure that the cache folder exists
   * @throw Throws an error, if it fails to create the cache folder
   */
  static checkCacheFolder() {
    try {
      fs.mkdirSync("cache");
    } catch (err) {
      if (err.code === "EEXIST") {
        // All good, folder is there
        return;
      }
      // Something went wrong
      throw err;
    }
  }

  /**
   * Retrieves the configuration
   * @returns {object}
   */
  static loadConfig() {
    try {
      return jsonFile.readFileSync("config.json");
    } catch (err) {
      if (err.code === "ENOENT") {
        Server.createConfig();
        return Server.loadConfig();
      }
      throw err;
    }
  }

  /**
   * Copy configuration file from the default one
   * @throws Throws an error, if it fails to copy the config
   */
  static createConfig() {
    console.log("Copying config file");
    fs.copySync("config.dist.json", "config.json");
  }

  /**
   * Start the web server
   */
  listen() {
    var server = this.expressServer.listen(this.config.listeningPort, "0.0.0.0", () => {
      var host = server.address().address;
      var port = server.address().port;
      console.log("Webserver listening at http://%s:%d", host, port);
    });
    this.webServer = server;

    this.registerHandlers();
  }

  /**
   * Set up listeners for the web server
   */
  registerHandlers() {
    this.expressServer.get("/id/:id", Server.raceHandler);
    //this.expressServer.get("/id/:id/remove", Server.removeCacheHandler);
    this.expressServer.get("/", Server.indexHandler);
    this.expressServer.get("/robots.txt", Server.robotsHandler);
  }

  /**
   * Index page handler
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   */
  static indexHandler(req, res) {
    let response = {status: "OK"};
    res.send(response);
  }

  /**
   * Robots.txt handler
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   */
  static robotsHandler(req, res) {
    let response = `User-agent: *
Disallow: `;
    res.send(response);
  }

  /**
   * Cache serving handler
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   */
  static raceHandler(req, res) {
    let id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(500).send({error: "Invalid ID parameter"});
      return;
    }

    Server.sendCached(res, id);
  }

  /**
   *
   * @param {Error|string} err
   */
  static errorLogger(err) {
    console.error(err);
  }

  /**
   * Update cache files
   */
  static updateCacheFiles() {
    console.log("Looking for files to update");
    fs.readdir("cache", (err, files) => {
      if (err) {
        console.error(err);
        return;
      }

      let delay = {counter: 0};
      for (let file of files) {
        let id = parseInt(file.substring(0, file.indexOf(".")), 10);
        if (isNaN(id)) {
          console.error(`'${id}' is not a number`);
          continue;
        }

        Server.checkUpdateNeeded(id, delay);
      }
    });
  }

  /**
   * Check if a specific cache item needs an update
   * @param {number} id - Cache ID
   * @param {Object} delay
   * @param {number} delay.counter
   */
  static checkUpdateNeeded(id, delay) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        console.log(err);
        return;
      }

      if (typeof data.rallyFinished !== "undefined" && data.rallyFinished === true) {
        return;
      }

      setTimeout(() => {
        Server.updateCache(id);
      }, delay.counter * 10000);
      delay.counter++;
    });
  }

  /**
   * Update cache item
   * @param {number} id - Cache ID
   */
  static updateCache(id) {
    console.log(`Updating cache for ${id}`);
    let response = {
      id: id,
      totalTime: 0,
      startTime: Date.now(),
      rallyData: [],
      requestCount: 1,
      rallyCount: null,
      ssFinished: null
    };

    let start = Date.now();
    http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
        }&leaderboard=true&noCache=${Date.now()}&page=1&stageId=0`, Server.firstFetchHandler.bind(null, response, start)
    ).on("error", Server.errorLogger);
  }

  /**
   * Container for response data before saving
   * @typedef {Object} Response
   * @property {number} id - Event ID
   * @property {number} totalTime - Total cumulative time taken for each request
   * @property {number} startTime - Time of beginning the update
   * @property {Array} rallyData - Array of stages
   * @property {number} requestCount - Amount of requests made
   * @property {number} rallyCount - Amount of stages
   * @property {number} ssFinished - Amount of processed stages
   */

  /**
   * Process the overall information response
   * @param {Response} response
   * @param {number} start Request start time
   * @param {ServerResponse} res
   */
  static firstFetchHandler(response, start, res) {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      let result = null;
      try {
        result = JSON.parse(body);
      } catch (err) {
        console.error(err);
        return;
      }

      response.rallyCount = result.TotalStages;
      response.ssFinished = 0;

      for (let i = 0; i <= response.rallyCount; i++) {
        if (i === 0) {
          Server.ssHandler(i, response, start, result);
        } else {
          response.requestCount++;
          setTimeout(() => {
            let start1 = Date.now();
            http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
                    }&leaderboard=true&noCache=${Date.now()}&page=1&stageId=${i}`,
                Server.ssHandler.bind(null, i, response, start1)
            ).on("error", Server.errorLogger);
          }, i * 1000);
        }
      }
    });
    res.on("error", Server.errorLogger);
  }

  /**
   * Process first page of a stage
   * @param {number} stage Stage number
   * @param {Response} response
   * @param {number} start
   * @param {ServerResponse} res
   */
  static ssHandler(stage, response, start, res) {
    let body = "";
    let endHandler = (jsonData) => {
      let time = Date.now() - start;
      response.totalTime += time;
      let ssResult = null;
      if (typeof jsonData === "object") {
        ssResult = jsonData;
      } else {
        try {
          ssResult = JSON.parse(body);
        } catch (err) {
          console.error(err);
          return;
        }
      }

      if (ssResult.Pages === 0 && stage === 1) {
        Server.stopUpdating(response.id);
        return;
      }

      ssResult.time = time;

      if (ssResult.Pages === 1) {
        response.rallyData[stage] = [ssResult];
        if (stage !== 0) {
          response.ssFinished++;
        }
        if (response.rallyCount === response.ssFinished) {
          Server.saveDataToCache(response);
        }
      } else {
        let promiseList = [];
        for (let i = 2; i <= ssResult.Pages; i++) {
          promiseList.push(new Promise((resolve, reject) => {
            response.requestCount++;
            setTimeout(() => {
              let start1 = Date.now();
              http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
                  }&leaderboard=true&noCache=${Date.now()}&page=${i}&stageId=${stage
                  }`, Server.ssPageHandler.bind(null, resolve, reject, response, start1)
              ).on("error", Server.errorLogger);
            }, i * 1000);
          }));
        }

        Promise.all(promiseList).then((values) => {
          values.splice(0, 0, ssResult);
          response.rallyData[stage] = values;
          if (stage !== 0) {
            response.ssFinished++;
          }

          if (response.rallyCount === response.ssFinished) {
            Server.saveDataToCache(response);
          }
        }, (reason) => {
          console.error(reason);
        });
      }

    };
    if (typeof res.Pages === "undefined") {
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", endHandler);
      res.on("error", Server.errorLogger);
    } else {
      endHandler(res);
    }
  }

  /**
   * @callback ResolveCallback
   * @param {T} result
   * @template T
   */

  /**
   * @callback RejectedCallback
   * @param {Error} reason - Rejected reason
   * @returns {S}
   * @template S
   */

  /**
   * Process additional pages of a stage
   * @param {ResolveCallback} resolve
   * @param {RejectedCallback} reject
   * @param {Response} response
   * @param {number} start
   * @param {ServerResponse} res
   */
  static ssPageHandler(resolve, reject, response, start, res) {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      let time = Date.now() - start;
      response.totalTime += time;
      let result = null;
      try {
        result = JSON.parse(body);
      } catch (err) {
        reject(err);
        return;
      }

      result.time = time;
      resolve(result);
    });
    res.on("error", (error) => {
      reject(error);
    });
  }

  /**
   * Process all the gathered data
   * @param {Response} data
   */
  static saveDataToCache(data) {
    var response = {
      id: data.id,
      stageData: [],
      stageCount: data.rallyCount,
      requestCount: data.requestCount,
      totalTime: data.totalTime
    };
    let processingFailed = false;
    data.rallyData.forEach((stage, index) => {
      if (index === 0) {
        return;
      }
      if (processingFailed === true) {
        return;
      }
      let stageData = null;
      for (let page of stage) {
        if (page.Page === 1) {
          stageData = {
            total: page.LeaderboardTotal,
            entries: [],
            times: []
          };
        }
        stageData.times.push(page.time);
        for (let entry of page.Entries) {
          stageData.entries.push({
            Position: entry.Position,
            PlayerId: entry.PlayerId,
            Name: entry.Name,
            VehicleName: entry.VehicleName,
            Time: entry.Time,
            DiffFirst: entry.DiffFirst
          });
        }
      }
      if (stage[0].LeaderboardTotal !== stageData.entries.length
          || stage[0].LeaderboardTotal < data.rallyData[0][0].LeaderboardTotal
          || (index > 1 && stage[0].LeaderboardTotal > data.rallyData[index - 1][0].LeaderboardTotal)) {
        console.error(`Entries is empty/smaller while it should not be!`);
        Server.retryCache(data.id);
        processingFailed = true;
        return;
      }
      response.stageData.push(stageData);
    });
    if (processingFailed === true) {
      return;
    }
    if (response.stageCount !== response.stageData.length) {
      console.error(`StageData count differs from intended stageCount!`);
      Server.retryCache(data.id);
      return;
    }
    response.actualTime = Date.now() - data.startTime;
    response.cacheTime = new Date();
    jsonFile.writeFile(`cache/${response.id}.json`, response, (err) => {
      if (err) {
        console.error(err);
        return;
      }
      console.log(`Log updated for ${response.id} in ${response.actualTime} ms with ${response.requestCount} requests`);
    });
  }

  /**
   * Queue a retry of a failed attempt to gather data of a stage
   * @param {number} id - Cache ID
   */
  static retryCache(id) {
    setTimeout(() => {
      console.log(`Retrying to update cache for ${id}`);
      Server.updateCache(id);
    }, 5000);
  }

  /**
   * Serve cached data of a stage
   * @param {ServerResponse} res
   * @param {number} id - Cache ID
   */
  static sendCached(res, id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        res.status(500).send(err);
        if (err.code === "ENOENT") {
          jsonFile.writeFile(`cache/${id}.json`, {error: "No data yet"}, (err) => {
            if (err) {
              console.error(err);
            }
          });
          Server.updateCache(id);
        }
        return;
      }
      res.send(data);
    });
  }

  /**
   * Stop updating a cache, if necessary
   * @param {number} id - Cache ID
   */
  static stopUpdating(id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        console.log(err);
        return;
      }

      if (typeof data.rallyFinished !== "undefined") {
        console.error(`stopUpdating should not have been called for ${id}, it's already marked as finished`);
        return;
      }

      if (typeof data.finishUpdating === "undefined") {
        data.finishUpdating = 1;
      } else {
        if (data.finishUpdating >= 2) {
          data.rallyFinished = true;
          delete data.finishUpdating;
        } else {
          data.finishUpdating++;
        }
      }

      jsonFile.writeFile(`cache/${id}.json`, data, (err) => {
        if (err) {
          console.log(err);
          return;
        }
        if (typeof data.rallyFinished !== "undefined") {
          console.log(`Stopping updates for ${id}`);
          if (typeof data.error !== "undefined") {

            Server.removeCache(id, (err) => {
              if (err) {
                console.error("Error removing cache", err);
                return;
              }
              console.log("Successfully removed redundant cache");
            });
          }
        } else {
          console.log(`Update stopping check ${data.finishUpdating} for ${id}`);
        }
      })
    });
  }

  /**
   * @callback errorCallback
   * @param {Error} [err]
   */

  /**
   *
   * @param {number} id - Cache ID
   * @param {errorCallback} [cb] - Callback when finished
   */
  static removeCache(id, cb) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        if (typeof cb === "function") cb(err);
        return;
      }

      if (typeof data.error === "undefined") {
        if (typeof cb === "function") cb("Event is not empty, not removing");
        return;
      }
      if (typeof data.rallyFinished === "undefined") {
        if (typeof cb === "function") cb("Server has not yet given up on the event");
        return;
      }

      fs.unlink(`cache/${id}.json`, (err) => {
        if (err) {
          if (typeof cb === "function") cb(err);
          return;
        }
        if (typeof cb === "function") cb();
      });
    });
  }
}

module.exports = Server;