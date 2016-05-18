# DirtProxy
Simple proxy to simplify grabbing driver results from an event from public Dirt Rally API.
## Overview
The proxy will automatically update cache for each event every 30 minutes until the Dirt API stops serving it (cleans up Entries).
## Getting started
### Prerequisites
Node.js
### Deployment
npm install
### Configuration
Listening port is configurable in server.js
### Running
npm start
### Usage
Pull data for event

```
/id/<event ID>
```