/* ***********************************************
 * whatsPlaying
 * Copyright (C) Greg Brown, All rights reserved.
 * https://github.com/gregtbrown/whatsPlaying
 * ***********************************************/

'use strict';

const Path = require('path');
const { networkInterfaces } = require('os');
const Hapi = require('@hapi/hapi');
const Querystring = require('querystring');
const RequestLib = require('request');
const OS = require('os');
const FS = require('fs');
const Config = require('./myconfig');

// -- globals --

var USER_SCOPE = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played user-top-read';
var gLoginUrl;
var gRedirectUri;
const gRedirectUriLocal = '/spotifyRedirect/';
const gStateKey = 'spotify_auth_state';
const gFileName = {
  homePage: 'index.html',
  token: Path.join(__dirname, 'data/token.json')
};

var gTokenInfo = {};
var gShouldWake = false;


// error handler
process.on('unhandledRejection', (err) => {

  console.log(err);
  process.exit(1);
});


// create the server
function createServer() {

  if (typeof Config.port === 'undefined')
    Config.port = 80;

  var serverOpts = {
    port: Config.port,
    routes: {
      cors: true,
      files: {
        relativeTo: Path.join(__dirname, 'public')
      }
    }
  };

  if (typeof Config.ip !== 'undefined')
    serverOpts.host = Config.ip;

  return new Hapi.server(serverOpts);
}

// setup the routes
function setupRoutes(server) {

  // notes:
  //   'control' --> control ui (i.e. home-page / login-screen)
  //   'app' --> app ui (i.e. now playing screen on device) 

  // default route
  server.route({
    method: '*',
    path: '/{any*}',
    handler: function (req, h) {
              var resp = h.response('Page Not Found!');
              resp.code(404);
              return resp;
            }
  });


  // control: home page (login screen)
  server.route({
    method: 'GET',
    path: '/',
    handler: function (req, h) { return h.file(gFileName.homePage); }
  });


  // control: do login
  server.route({
    method: 'GET',
    path: '/login',
    handler: async function (req, h) { return doLogin(req, h); }
  });


  // control: callback route from spotify login redirect
  server.route({
    method: 'GET',
    path: gRedirectUriLocal,
    handler: async function (req, h) { return doLoginRedirect(req, h); }
  });


  // control: do logout
  server.route({
    method: 'PUT',
    path: '/logout',
    handler: async function (req, h) { return doLogout(req, h); }
  });


  // control: is logged in
  server.route({
    method: 'GET',
    path: '/islogin',
    handler: async function (req, h) { return gTokenInfo.accessToken ? true : false; }
  });


  // control: enable wakeup state
  server.route({
    method: 'PUT',
    path: '/setwake',
    handler: async function (req, h) {
               debug('wakeup');
               gShouldWake = true;
               return 'success';
             }
  });


  // app/control: get wake state
  // note: assumed polling on this while asleep (and not calling accessToken to reset)
  server.route({
    method: 'GET',
    path: '/shouldwake',
    handler: async function (req, h) { return gShouldWake; }
  });


  // app: get login url
  server.route({
    method: 'GET',
    path: '/loginUrl',
    handler: function (req, h) { return {url: gLoginUrl}; }
  });

  // app: get current access token
  // note: resets gShouldWake=false
  server.route({
    method: 'GET',
    path: '/accessToken',
    handler: function (req, h) { return getAccessToken(req, h); }
  });
}


// -- helper functions --

function debug(msg) {
  if (!Config.debug)
    return;
  console.log(msg);
}

// start the server
async function run() {
  var server = createServer();
  setupRoutes(server);
  loadTokenInfo();
  setRedirectUri();
  await server.register(require('@hapi/inert'));  // static file handling
  server.state(gStateKey /*, {options}*/);  // config state cookie
  await server.start();
  debug(`Server running at: ${server.info.uri}`);
};


function getMyIp() {
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
      if (net.family === familyV4Value && !net.internal) {
        return net.address;
      }
    }
  }
}

function setRedirectUri()
{
  var ip;

  if (typeof Config.ip !== 'undefined')
    ip = Config.ip;
  else
    ip = OS.hostname();  // TODO: not alaways computer name

  gRedirectUri = 'http://';
  gRedirectUri += ip;  //.toUpperCase();

  if (Config.port != 80)
    gRedirectUri += `:${Config.port}`;

  gLoginUrl = gRedirectUri;

  gRedirectUri += gRedirectUriLocal;

  debug(`gLoginUrl: "${gLoginUrl}"`);
  debug(`gRedirectUri: "${gRedirectUri}"`);
}

function generateRandomString(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

function ensurePathExists(fileName) {
  var dirName = Path.dirname(fileName);
  if (FS.existsSync(dirName)) {
    return true;
  }
  ensurePathExists(dirName);
  FS.mkdirSync(dirName);
}

function readFile(fileName, allowFail) {
  var data = {};
  try {
    data = FS.readFileSync(fileName, 'utf8');
    data = JSON.parse(data);
  } catch(e) {
    if (!allowFail)
      console.log(`Error reading file "${fileName}"\n${e.message}`);
    data = {};
  }

  return data;
}

function writeFile(fileName, data) {
  try {
    var f = FS.openSync(fileName, 'w');
    FS.writeSync(f, JSON.stringify(data, null, 2));
    FS.closeSync(f);
  } catch(e) {
    console.log(`Error writing file "${fileName}"\n${e.message}`);
  }
}

function loadTokenInfo() {
  var data = readFile(gFileName.token, true);
  if ( data)
    gTokenInfo = data;
}

function saveTokenInfo() {
  ensurePathExists(gFileName.token);
  writeFile(gFileName.token, gTokenInfo);
}

// wrapper for post/fetch
async function post(options) {

  // note: ideally get rid of request library since it is deprecated

  if (typeof RequestLib !== 'undefined') {
    return new Promise(function(resolve, reject) {
      RequestLib.post(options, function(error, response, body) {
        if (error)
          reject(error);
        else
          resolve({response: response, body: body});
      });
    });
  }

  // note: fetch in node is still experimental

  var body = options.form;
  if (body) {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = Querystring.stringify(body);
  } else {
    body = options.json;
    options.headers['Content-Type'] = 'application/json';
  }

  var res = await fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: body
  });

  var status = res.status;

  if (status == 200)
    res = await res.json();
  else
    res = null;

  return {response: {statusCode: status}, body: res};
}


// get request code
function doLogin(req, h) {
  debug('starting login process');
  var stateVal = generateRandomString(16);

  gTokenInfo.reqState = stateVal;

  var query = {
    response_type: 'code',
    client_id: Config.clientId,
    scope: USER_SCOPE,
    redirect_uri: gRedirectUri,
    state: stateVal
  };

  // we don't actually log out, just delete our access token
  // if so, force the login process to show the spotify login ui instead of using existing cookies
  if (!gTokenInfo.accessToken)
    query.show_dialog = true;

  // request authorization
  return h.redirect('https://accounts.spotify.com/authorize?' + Querystring.stringify(query));
}

function doLogout(req, h) {
  debug('logging out');
  gTokenInfo = {};
  saveTokenInfo();
  return 'success';
}

// get access token from login redirect
async function doLoginRedirect(req, h) {
  debug('completing login process');

  // get query params
  var code = req.query.code;
  var state = req.query.state;

  if (!code) {  // user did not accept
    return h.redirect('/#' + Querystring.stringify({error: req.query.error}));
  }
  
  var storedState = gTokenInfo.reqState;
  gTokenInfo.reqState = null;

  if (state === null || state !== storedState) {
    console.log('error: state mismatch');
    return h.redirect('/#' + Querystring.stringify({error: 'state_mismatch', req: storedState, resp: state}));
  } else {
    debug('getting access token');

    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: gRedirectUri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + btoa(Config.clientId + ':' + Config.clientSecret)
      },
      json: true
    };

    var res = await post(authOptions);
    if (res && res.response.statusCode === 200) {
      var data = res.body;
      gTokenInfo = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expires: new Date(Date.now() + (data.expires_in * 1000)).getTime()
      };
      debug(JSON.stringify(gTokenInfo));
      saveTokenInfo();
      return h.redirect('/#' + Querystring.stringify({res: 'success'}));
    }

    return h.redirect('/#' + Querystring.stringify({res: 'fail'}));
  }
}

async function getAccessToken(req, h) {
  var now = Date.now();

  gShouldWake = false;

  if (!gTokenInfo.accessToken)  // not logged in yet
    return {error: 'login', ts: now};

  if (now > gTokenInfo.expires - (2 * 60 * 1000)) {  // token (minus 2 minute margin) expired
    var res = await refreshToken();
    if (!res)
      return {error: 'token', ts: now};
  }

  return {token: gTokenInfo.accessToken, ts: now};
}

// get updated access token from refresh token
async function refreshToken() {
  debug('refreshing access token');

  if (!gTokenInfo.refreshToken)
    return false;

  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + btoa(Config.clientId + ':' + Config.clientSecret) },
    form: {
      grant_type: 'refresh_token',
      refresh_token: gTokenInfo.refreshToken
    },
    json: true
  };

  var rtrn = false;
  var res = await post(authOptions);
  if (res && res.response.statusCode === 200) {
    gTokenInfo.accessToken = res.body.access_token;
    gTokenInfo.expires = new Date(Date.now() + (res.body.expires_in * 1000)).getTime();
    debug(JSON.stringify(gTokenInfo));
    rtrn = true;
  } else {
    // refresh failed, force a new login
    gTokenInfo = {};
  }

  saveTokenInfo();

  return rtrn;
}


run();