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

class Server {
  constructor() {
    this.expressServer = express();

    this.cronJob = schedule.scheduleJob("*/30 * * * *", this.updateCacheFiles.bind(this));
  }

  listen() {
    var server = this.expressServer.listen(3021, "0.0.0.0", () => {
      var host = server.address().address;
      var port = server.address().port;
      util.log("Webserver listening at http://%s:%s", host, port);
    });
    this.webServer = server;

    this.registerHandlers();
  }

  registerHandlers() {
    this.expressServer.get("/:id", this.raceHandler.bind(this));
    this.expressServer.get("/", Server.indexHandler.bind(this));
  }

  static indexHandler(req, res) {
    let response = {status: "OK"};
    res.send(response);
  }

  raceHandler(req, res) {
    let id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(500).send({error: "Invalid ID parameter"});
      return;
    }

    this.sendCached(res, id);
  }

  updateCacheFiles() {
    util.log("Looking for files to update");
    fs.readdir("cache", (err, files) => {
      if (err) {
        console.error(err);
        return;
      }

      for (let file of files) {
        let id = parseInt(file.substring(0, file.indexOf(".")), 10);
        if (isNaN(id)) {
          console.error(`'${id}' is not a number`);
          continue;
        }

        this.checkUpdateNeeded(id);
      }
    });
  }

  updateCache(id) {
    util.log(`Updating cache for ${id}`);
    let response = {
      id: id,
      totalTime: 0,
      startTime: Date.now(),
      rallyData: [],
      requestCount: 0
    };

    let start = Date.now();
    http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
        }&leaderboard=true&noCache=${Date.now()}&page=1&stageId=0`, this.firstFetchHandler.bind(this, response, start));
  }

  checkUpdateNeeded(id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        util.log(err);
        return;
      }

      if (typeof data.rallyFinished !== "undefined" && data.rallyFinished === true) {
        return;
      }

      this.updateCache(id);
    });
  }

  firstFetchHandler(response, start, res) {
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

      if (result.Pages === 0) {
        this.stopUpdating(response.id);
        return;
      }

      response.rallyCount = result.TotalStages;
      response.ssFinished = 0;

      for (let i = 1; i <= response.rallyCount; i++) {
        if (i === 0) {
          this.ssHandler(i, response, start, result);
        } else {
          response.requestCount++;
          let start1 = Date.now();
          http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id}&leaderboard=true&noCache=${Date.now()}&page=1&stageId=${i}`, this.ssHandler.bind(this, i, response, start1));
        }
      }
    });
  }

  ssHandler(stage, response, start, res) {
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

      if (ssResult.Pages === 0) {
        this.stopUpdating(response.id);
        return;
      }

      ssResult.time = time;

      if (ssResult.Pages === 1) {
        response.rallyData[stage] = [ssResult];
        response.ssFinished++;
        if (response.rallyCount === response.ssFinished) {
          this.saveDataToCache(response);
        }
      } else {
        let promiseList = [];
        for (let i = 2; i <= ssResult.Pages; i++) {
          promiseList.push(new Promise((resolve, reject) => {
            response.requestCount++;
            let start1 = Date.now();
            http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
                }&leaderboard=true&noCache=${Date.now()}&page=${i}&stageId=${stage
                }`, this.ssPageHandler.bind(this, resolve, reject, response, start1));
          }));
        }

        Promise.all(promiseList).then((values) => {
          values.splice(0, 0, ssResult);
          response.rallyData[stage] = values;
          response.ssFinished++;

          if (response.rallyCount === response.ssFinished) {
            this.saveDataToCache(response);
          }
        }, (reason) => {
          console.error(reason);
          if (reason === "CACHE") {
            this.stopUpdating(response.id);
          }
        });
      }

    };
    if (typeof res.Pages === "undefined") {
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", endHandler.bind(this));
      res.on("error", (err) => {
        console.error(err);
      })
    } else {
      endHandler(res);
    }
  }

  ssPageHandler(resolve, reject, response, start, res) {
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

      if (result.Pages === 0) {
        reject("CACHE");
        return;
      }

      result.time = time;
      resolve(result);
    });
    res.on("error", (error) => {
      reject(error.message);
    });
  }

  saveDataToCache(data) {
    data.rallyData.splice(0, 1);
    var response = {
      id: data.id,
      stageData: [],
      stageCount: data.rallyCount,
      requestCount: data.requestCount,
      totalTime: data.totalTime
    };
    for (let stage of data.rallyData) {
      let stageData = null;
      for (let page of stage) {
        if (page.Page === 1) {
          stageData = page;
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
      response.stageData.push(stageData);
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

  sendCached(res, id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        res.status(500).send(err);
        if (err.code === "ENOENT") {
          jsonFile.writeFile(`cache/${id}.json`, {error: "No data yet"}, (err) => {
            if (err) {
              console.error(err);
            }
          });
          this.updateCache(id);
        }
        return;
      }
      res.send(data);
    });
  }

  stopUpdating(id) {
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
        if (data.finishUpdating > 2) {
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
        } else {
          util.log(`Update stopping check ${data.finishUpdating} for ${id}`);
        }
      })
    });
  }
}

module.exports = Server;