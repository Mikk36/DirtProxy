/**
 * Created by Mikk on 4.05.2016.
 */
"use strict";

const util = require("util");
const express = require("express");
const http = require("https");
const fs = require("fs");
const jsonFile = require("jsonfile");
const schedule = require("node-schedule");
const morgan = require('morgan');

// Config
const listeningPort = 3021;
// Config end

class Server {
  constructor() {
    let cacheTest = Server.checkCacheFolder();
    if (cacheTest !== true) {
      console.error(cacheTest);
      return;
    }

    this.expressServer = express();
    this.expressServer.use(morgan(":date[iso] :remote-addr :method :url :status :res[content-length]"));

    this.cronJob = schedule.scheduleJob("*/30 * * * *", Server.updateCacheFiles);

    //Server.updateCacheFiles();
  }

  static checkCacheFolder() {
    try {
      fs.mkdirSync("cache");
      // Folder created
      return true;
    } catch (err) {
      if (err.code == 'EEXIST') {
        // All good, folder is there
        return true;
      }
      // Something went wrong
      return err;
    }
  }

  listen() {
    var server = this.expressServer.listen(listeningPort, "0.0.0.0", () => {
      var host = server.address().address;
      var port = server.address().port;
      util.log("Webserver listening at http://%s:%s", host, port);
    });
    this.webServer = server;

    this.registerHandlers();
  }

  registerHandlers() {
    this.expressServer.get("/id/:id", Server.raceHandler);
    //this.expressServer.get("/id/:id/remove", Server.removeCacheHandler);
    this.expressServer.get("/", Server.indexHandler);
    this.expressServer.get("/robots.txt", Server.robotsHandler);
  }

  static indexHandler(req, res) {
    let response = {status: "OK"};
    res.send(response);
  }

  static robotsHandler(req, res) {
    let response = `User-agent: *
Disallow: `;
    res.send(response);
  }

  static raceHandler(req, res) {
    let id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(500).send({error: "Invalid ID parameter"});
      return;
    }

    Server.sendCached(res, id);
  }

  static errorLogger(err) {
    console.error(err);
  }

  static updateCacheFiles() {
    util.log("Looking for files to update");
    fs.readdir("cache", (err, files) => {
      if (err) {
        console.error(err);
        return;
      }

      let i = 0;
      for (let file of files) {
        let id = parseInt(file.substring(0, file.indexOf(".")), 10);
        if (isNaN(id)) {
          console.error(`'${id}' is not a number`);
          continue;
        }

        setTimeout(() => {
          Server.checkUpdateNeeded(id);
        }, i * 10000);
        i++;
      }
    });
  }

  static updateCache(id) {
    util.log(`Updating cache for ${id}`);
    let response = {
      id: id,
      totalTime: 0,
      startTime: Date.now(),
      rallyData: [],
      requestCount: 1
    };

    let start = Date.now();
    http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
        }&leaderboard=true&noCache=${Date.now()}&page=1&stageId=0`, Server.firstFetchHandler.bind(null, response, start)
    ).on("error", Server.errorLogger);
  }

  static checkUpdateNeeded(id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        util.log(err);
        return;
      }

      if (typeof data.rallyFinished !== "undefined" && data.rallyFinished === true) {
        return;
      }

      Server.updateCache(id);
    });
  }

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
      util.log(`Log updated for ${response.id} in ${response.actualTime} ms with ${response.requestCount} requests`);
    });
  }

  static retryCache(id) {
    setTimeout(() => {
      util.log(`Retrying to update cache for ${id}`);
      Server.updateCache(id);
    }, 5000);
  }

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

  static stopUpdating(id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        util.log(err);
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
          util.log(err);
          return;
        }
        if (typeof data.rallyFinished !== "undefined") {
          util.log(`Stopping updates for ${id}`);
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
          util.log(`Update stopping check ${data.finishUpdating} for ${id}`);
        }
      })
    });
  }

  // static removeCacheHandler(req, res) {
  //   let id = parseInt(req.params.id, 10);
  //   if (isNaN(id)) {
  //     res.status(500).send({error: "Invalid ID parameter"});
  //     return;
  //   }
  //
  //   Server.removeCache(id, (err) => {
  //     if (err) {
  //       console.error(err);
  //       res.status(500).send({error: err});
  //       return;
  //     }
  //     res.send({status: "OK"});
  //   });
  // }

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