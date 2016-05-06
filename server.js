/**
 * Created by Mikk on 4.05.2016.
 */
"use strict";

const util = require("util");
const express = require("express");
const http = require("https");
const jsonFile = require('jsonfile');

class Server {
  constructor() {
    this.express = express();
  }

  listen() {
    var server = this.express.listen(3021, "0.0.0.0", () => {
      var host = server.address().address;
      var port = server.address().port;
      util.log("Webserver listening at http://%s:%s", host, port);
    });
    this.server = server;

    this.registerHandlers();
  }

  registerHandlers() {
    this.express.get("/:id", this.raceHandler.bind(this));
    this.express.get("/", Server.indexHandler.bind(this));
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

  updateCache(id) {
    let response = {
      id: id,
      totalTime: 0,
      startTime: Date.now(),
      rallyData: [],
      requestCount: 1
    };

    // https://www.dirtgame.com/uk/api/event?assists=any&eventId=91822&leaderboard=true&noCache=1462395458947&page=1&stageId=0
    let start = Date.now();
    http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${response.id
        }&leaderboard=true&noCache=${Date.now()}&page=1&stageId=0`, this.firstFetchHandler.bind(this, response, start));
  }

  firstFetchHandler(response, start, res) {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      let result = JSON.parse(body);

      if (result.Pages === 0) {
        this.stopUpdating(response.id);
        return;
      }

      //response.rallyData.push([result]);
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

      //originalRes.send(response);
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
        ssResult = JSON.parse(body);
      }

      if (ssResult.Pages === 0) {
        this.stopUpdating(response.id);
        return;
      }

      ssResult.time = time;
      //response.rallyData[stage] = [result];
      //response.ssFinished[stage] = false;

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
          // if(reason === "CACHE") {
          //   Server.sendCached(response.id, originalRes);
          //   return;
          // }
          // originalRes.status(500).send(reason);
          util.error(reason);
        });
      }

    };
    if (typeof res.Pages === "undefined") {
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", endHandler.bind(this));
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
      let result = JSON.parse(body);

      if (result.Pages === 0) {
        reject("CACHE");
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
        util.error(err);
        return;
      }
      this.startUpdating(response.id);
    });
    //originalRes.send(response);
  }

  sendCached(res, id) {
    jsonFile.readFile(`cache/${id}.json`, (err, data) => {
      if (err) {
        res.status(500).send(err);
        if (err.code === "ENOENT") {
          jsonFile.writeFile(`cache/${id}.json`, {error: "No data yet"}, (err) => {
            if (err) {
              util.error(err);
            }
          });
          this.updateCache(id);
        }
        return;
      }
      res.send(data);
    });
  }

  startUpdating(id) {
    // TODO: implement startUpdating(id)
  }

  stopUpdating(id) {
    // TODO: implement stopUpdating(id)
  }
}

module.exports = Server;