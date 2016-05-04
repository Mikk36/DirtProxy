/**
 * Created by Mikk on 4.05.2016.
 */
"use strict";

var util = require("util");
var express = require("express");
var http = require("https");

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
    this.express.get("/:id", Server.raceHandler.bind(this));
    this.express.get("/", Server.indexHandler.bind(this));
  }

  static indexHandler(req, res) {
    let response = {status: "OK"};
    res.send(response);
  }

  static raceHandler(req, res) {
    let response = {
      status: "OK"
    };
    let id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(500).send({error: "Invalid ID parameter"});
      return;
    }
    response.id = id;

    var rallyData = [];
    // https://www.dirtgame.com/uk/api/event?assists=any&eventId=91822&leaderboard=true&noCache=1462395458947&page=1&stageId=0
    http.get(`https://www.dirtgame.com/uk/api/event?assists=any&eventId=${id}&leaderboard=true&noCache=${Date.now()}&page=1&stageId=0`, (getRes) => {
      let body = "";
      getRes.on("data", (chunk) => {
        body += chunk;
      });
      getRes.on("end", () => {
        let result = JSON.parse(body);
        response.rallyCount = result.TotalStages;

        res.send(response);
      });
    });
  }
}

module.exports = Server;