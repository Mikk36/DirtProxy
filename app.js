/**
 * Created by Mikk on 4.05.2016.
 */
var Server = require("./server");

var server = null;
try {
  server = new Server();
  server.listen();
} catch (err) {
  console.error(err);
}