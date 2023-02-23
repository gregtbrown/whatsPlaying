/* ***********************************************
 * whatsPlaying
 * Copyright (C) Greg Brown, All rights reserved.
 * https://github.com/gregtbrown/whatsPlaying
 * ***********************************************/

var SVGNS = 'http://www.w3.org/2000/svg';
var SVGXLINK = 'http://www.w3.org/1999/xlink';

const spotifyRoutes = {
  playbackState: {type: 'GET', url: 'me/player'},
  currentPlaying: {type: 'GET', url: 'me/player/currently-playing'},
  recentlyPlayed: {type: 'GET', url: 'me/player/recently-played?limit=1'},  // items[].track instead of item
  getPlaylist: {type: 'GET', url: 'playlists/{0}'},  // + playlist_id
  getPlaylistImage: {type: 'GET', url: 'playlists/{0}/images'},  // + playlist_id
  getArtist: {type: 'GET', url: 'artists/{0}'},  // + artist_id
  playPlay: {type: 'PUT', url: 'me/player/play{0}'},
  playPause: {type: 'PUT', url: 'me/player/pause{0}'},
  playNext: {type: 'POST', url: 'me/player/next{0}'},
  playPrev: {type: 'POST', url: 'me/player/previous{0}'},

  // time_range:
  //   'long_term' (calculated from several years of data and including all new data as it becomes available)
  //   'medium_term' (approximately last 6 months)
  //   'short_term' (approximately last 4 weeks)
  topArtists: {type: 'GET', url: 'me/top/artists?limit={0}&time_range={1}'},
  topTracks: {type: 'GET', url: 'me/top/tracks?limit={0}&time_range={1}'},
};

var gLoginUrl;
var gCurScreen;
var gUpdateTimer;
var gNowPlaying = {};
var gLastVal = {playPerc: -1};  // cache of previous values

var gAccessToken;  // store this from last call, but null on error

// run single setInterval timer and handle our own timers manually in that
var gTimer = {
  clock: {
    callback: updateClock,
    interval: 500,
    lastTic: 0
  },
  timeBar: {
    callback: updatePayerUi,
    interval: 500,
    lastTic: 0
  },
  server: {
   callback: updateServer,
   interval: 1000,
   lastTic: 0,
  },
  playback: {
    callback: updatePlayback,
    interval: 3000,
    lastTic: 0,
 },
};


// get everything started
window.addEventListener('load', initialize, true);


async function initialize() {
  if (!Config.serverUrl)
    Config.serverUrl = 'http://localhost/';
  if (!Config.serverUrl.endsWith('/'))
    Config.serverUrl += '/';

  if (!Config.idleMinutes)
    Config.idleMinutes = 5;
    
  // trap our hotkeys
  window.addEventListener("keydown", function(event)
  {
    if (gNowPlaying.isSleeping) {  // any key to wake
      gNowPlaying.isSleeping = false;
      updatePlayback();
    }
    else if (event.keyCode == 37) {    // left arrow
      uiCmd('prev');
    } else if (event.keyCode == 39) {  // right arrow
      uiCmd('next');
    } else if (event.keyCode == 13) {  // enter
      uiCmd('play');
    } else {
      return;
    }

    event.preventDefault();  // block std handler
  });


  // get login url
  var res = await getLocal('loginUrl');
  debug(res);
  if (res && res.data)
    gLoginUrl = res.data.url;

  var elem = document.getElementById('body');
  elem.style.cursor = Config.showMouse ? 'auto' : 'none';
  

  elem = document.getElementById('loginContent');
  elem.innerHTML = `Log in at<br><br>${gLoginUrl}`;

  elem = document.getElementById('sleepContent');
  elem.innerHTML = `Wake me at<br><br>${gLoginUrl}`;

  // initial update
  updateClock();
  await updateServer();

  setInterval(timerUpdates, 1000);
}


// -- generic helpers --

function debug(msg) {
  if (!Config.debug)
    return;
  console.log(msg);
}

function hasClass(elem, className) { return elem.classList.contains(className); }
function addClass(elem, className) { elem.classList.add(className); }
function removeClass(elem, className) { elem.classList.remove(className); }
function toggleClass(elem, className) { elem.classList.toggle(className); }

function clearChildren(elem)
{
  while (elem.firstChild)
    elem.removeChild(elem.firstChild);
}

function changeSvgIcon(iconElem, newName)
{
  clearChildren(iconElem);

  var icon_use = document.createElementNS(SVGNS, 'use');
  icon_use.setAttributeNS(SVGXLINK, 'href', '#' + newName);
  iconElem.appendChild(icon_use);
}

function format(string, args) {
  if (!string)
    return '';
  return string.replace(/{([0-9]+)}/g, function (match, index) {
    var arg = args[index];
    return typeof arg == 'undefined' ? '' : arg;
  });
};


// -- app functions --

function uiCmd(cmd) {

  var arg = gLastVal.deviceId ? `?device_id=${gLastVal.deviceId}` : null;

  if (cmd === 'play') {
    spotifyApi(gNowPlaying.isPlaying ? spotifyRoutes.playPause : spotifyRoutes.playPlay, arg);
    // TODO: this can cause bounce if we get an update before it actually gets set
    //gNowPlaying.isPlaying = !gNowPlaying.isPlaying;
  } else if (cmd === 'next') {
    spotifyApi(spotifyRoutes.playNext, arg);
  } else if (cmd === 'prev') {
    spotifyApi(spotifyRoutes.playPrev, arg);
  } else {
    return;
  }

  // bump up the refresh rate until we get a change
  gTimer.playback.nextInterval = 3000;
  gTimer.playback.interval = 500;
  gTimer.playback.count = 0;
  gNowPlaying.expectingChange = 10;  // max count fallback
}

function handleError(err) {
  if (!err)
    err = {error: 'unkown'};

  if (!err.error) {
    return;
  } else if (err.error == 'login') {
    selectScreen('loginScreen');
  } else {
    var elem = document.getElementById('errorContent');
    elem.innerHTML = err.error;
    selectScreen('errorScreen');
  }
}

function selectScreen(name) {
  if ( name == gCurScreen)
    return;

  if (gCurScreen) {
    var elem = document.getElementById(gCurScreen);
    removeClass(elem, 'screenOn');
    addClass(elem, 'screenOff');
  }

  gCurScreen = name;

  if (gCurScreen) {
    var elem = document.getElementById(gCurScreen);
    removeClass(elem, 'screenOff');
    addClass(elem, 'screenOn');

    if (gCurScreen === 'playingScreen') {
      // if configured, play controls are always on, even in idle state
      if (Config.showPlayerControls)
        showPlayControls(true);
    }
  }
}

function setTimer(name, interval) {
  gTimer[name].interval = interval;
}

function timerUpdates() {
  var now = Date.now();

  for (t in gTimer) {
    var timer = gTimer[t];
    if (now >= timer.lastTic + timer.interval) {
      timer.count = timer.count + 1;
      timer.callback();
      timer.lastTic = now;
    }
  }
}

async function updateServer() {
  // if we're sleeping, poll on shouldwake until we're not
  if (gNowPlaying.isSleeping) {
    var res = await getLocal('shouldwake');
    if (res.error) {
      handleError(res);
      return;
    } else if (!res.data) {  // still sleeping
      return;
    } else {
      gNowPlaying.isSleeping = false;
      gNowPlaying.lastPlayingTime = Date.now();
      // fall through
    }
  }

  var curToken = gAccessToken;
  var res = await getLocal('accessToken');
  if (res.error)
    gAccessToken = null;
  else
    gAccessToken = res.data.token;

  if (curToken == null && gAccessToken != null) {  // switch away from error condition
    res = await getInitialPlaybackState();
    if (!res.error)
      selectScreen('playingScreen');
  }

  handleError(res);
}

async function updatePlayback() {
  var res;

  if (!gAccessToken || gNowPlaying.isSleeping)
    return;

  if (gCurScreen !== 'playingScreen')
    res = await getInitialPlaybackState();
  else
    res = await getPlaybackState();

  if (!res.error && !gNowPlaying.isSleeping && Config.sleepMinutes) {
    var now = Date.now();
    if (gNowPlaying.isIdle && gNowPlaying.lastPlayingTime && now - gNowPlaying.lastPlayingTime > (Config.sleepMinutes * 60 * 1000)) {
      gNowPlaying.isSleeping = true;
      selectScreen('sleepScreen');
      return;
    }
  }

  if (!res.error)
    selectScreen('playingScreen');
  else
    handleError(res);
}

async function getInitialPlaybackState() {
  gNowPlaying = {};
  var res = await getPlaybackState();
  if (res.error)
    return res;
  if (!gNowPlaying.id) {  // nothing playing, show most recent
    res = await getRecentlyPlayed();
    if (res.error)
      return res;
    gNowPlaying = res.data;
    gNowPlaying.isIdle = true;
    gNowPlaying.isPlaying = false;

    updatePlayingScreen(gNowPlaying);
  }

  gNowPlaying.lastPlayingTime = Date.now();  // always set this on start

  return res;
}

function updatePayerUi() {
  // simulate progress bar between updates
  if (gCurScreen === 'playingScreen')
    updatePlayMeter(gNowPlaying, true);

  if (gLastVal.isPlaying != gNowPlaying.isPlaying) {
    gLastVal.isPlaying = gNowPlaying.isPlaying;
    var elem = document.getElementById('playingPlay');
    changeSvgIcon(elem.children[0], gLastVal.isPlaying ? 'iconPause' : 'iconPlay')
  }
}

function updateClock() {
  // TODO: option to enable clock

  function pad(input) {
    return input < 10 ? '0' + input : input;
  }

  function timeStr(date) {
    var hr = date.getHours();
    var ampm;

    if ( hr < 12 )
      ampm = 'am';
    else {
      ampm = 'pm';
      if (hr > 12)
        hr -= 12;
    }

    return "".concat(hr, ':', pad(date.getMinutes()), ampm);
  }

  var now = new Date();
  if (now == gLastVal.clock)
    return;

  gLastVal.clock = now;

  clock = document.getElementById('clock');
  if (clock)
    clock.innerHTML = timeStr(now);
}

function showPlayControls(show) {
  var elem = document.getElementById('playingControls');
  elem.style.display = show ? 'block' : 'none';
}

function showPlayMeter(show) {
  var elem = document.getElementById('playingMeter');
  elem.style.opacity = show ? '1' : '0';
}

function updatePlayMeter(data, interpolate) {
  if (!data || !data.isPlaying)
    return;

  var progress = data.progress;
  if (interpolate)
    progress += Date.now() - data.time;  // adjust by time elapsed since last update

  var perc = (progress * 100) / data.duration;
  if (perc > 100)
    perc = 100;

  if (perc == gLastVal.playPerc)
    return;

  gLastVal.playPerc = perc;

  var elem = document.getElementById('playingMeterValue');
  elem.style.width = `${isNaN(perc) ? 0 : perc}%`;

  showPlayMeter(true);
}

function updatePlayingScreen(data) {
  function setText(id, text) {
    var elem = document.getElementById(id);
    if (elem)
      elem.innerHTML = text ? text : '';
  }

  setText('playingTrack', data.track);
  setText('playingAlbum', data.album);
  setText('playingArtist', data.artist);
  setText('playingDate', data.date);
  setText('playingPlaylist', data.playlist);
  updatePlayMeter(gNowPlaying);

  if (data.albumImage != gLastVal.albumImage) {
    gLastVal.albumImage = data.albumImage;
    var elem = document.getElementById('playingAlbumImage');
    if (elem) {
      if (!data.albumImage)
        elem.style.opacity = '0';
      else {
        elem.src = data.albumImage;
        elem.style.opacity = '1';
      }
    }
  }
}

function getArtistName(artists) {
  var artist = '';

  // concat artist names
  for (var i = 0; i < artists.length; i++) {
    if ( i > 0 )
      artist += ', ';
    artist += artists[i].name;
  }

  return artist;
}

function getGenre(genres) {
  var genre = '';

  // concat genres
  for (var i = 0; i < genres.length; i++) {
    if ( i > 0 )
      genre += ', ';
    genre += genres[i];
  }

  return genre;
}

function getYearFromDate(date, precision) {
  // TODO: currently assuming type 'month' is yyyy-mm, but tbd
  if (!date)
    return '';
  if (precision !== 'year') {
    date = date.split('-')[0];  // yyyy-mm-dd
  }
  return date;
}

function getAlbumImage(images, largest = true) {
  // get largest/smallest album image
  var image;
  var w = largest ? 0 : 100000;

  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if ((largest && img.width > w) || (!largest && img.width < w)) {
      image = img.url;
      w = img.width;
    }
  }

  if (!image)
    image = './music.png';
  return image;
}

async function getPlaybackState() {
  // using 'playbackState' instead of 'currentPlaying' so we can get the current playback device
  var res = await spotifyApi(spotifyRoutes.playbackState);

  if (res.error)
    return res;

  var data = res.data;
  debug(data);

  var now = Date.now();
  var prevPlaying = gNowPlaying.isPlaying;
  var prevId = gNowPlaying.id;

  if ( data == null ) {
    gNowPlaying.isPlaying = false;
    prevId = !gNowPlaying.isPlaying;  // force a change
  } else {

    if (data.device)
      gLastVal.deviceId = data.device.id;

    var track = data.item;
    if (!track) {
      gNowPlaying.name = 'unknown';
    } else {
      var album = track.album;
      var id = track.uri;
      var oldId = gNowPlaying.id;

      if (id != oldId) {
        // maybe get playlist name
        var playlist;
        if ( data.context && data.context.type == 'playlist' && data.context.href ) {
          var pl = await spotifyApiDirect('GET', data.context.href);
          if ( pl ) {
            playlist = pl.data.name;
          }
        }

        gNowPlaying.type = data.currently_playing_type;  // e.g. 'track'
        gNowPlaying.id = id;                             // track ID
        gNowPlaying.track = track.name;
        gNowPlaying.album = album.name;
        gNowPlaying.artist = getArtistName(track.artists);
        gNowPlaying.date = getYearFromDate(album.release_date, album.release_date_precision);
        gNowPlaying.explicit = track.explicit;
        gNowPlaying.popularity = track.popularity;
        gNowPlaying.playlist = playlist;
        gNowPlaying.albumImage = getAlbumImage(album.images);
        gNowPlaying.duration = track.duration_ms;
      }
    }

    // always update play meter info
    gNowPlaying.progress = data.progress_ms;
    gNowPlaying.isPlaying = data.is_playing;
    gNowPlaying.time = now;  // time of update
    gNowPlaying.isIdle = false;

    if (gNowPlaying.isPlaying)
      gNowPlaying.lastPlayingTime = now;  // last time we saw something playing

    debug(gNowPlaying);

    if (id == oldId) {
      updatePlayMeter(gNowPlaying);
    } else {
      updatePlayingScreen(gNowPlaying);
      selectScreen('playingScreen');
    }
  }

  // check if we need to reset our update timer
  if (gNowPlaying.expectingChange &&
      (gTimer.playback.count >= gNowPlaying.expectingChange ||
       gNowPlaying.isPlaying != prevPlaying || gNowPlaying.id != prevId)) {
    gNowPlaying.expectingChange = false;
    gTimer.playback.interval = gTimer.playback.nextInterval;
  }

  // check if idle time elapsed
  if (!gNowPlaying.isPlaying && !gNowPlaying.isIdle &&
      gNowPlaying.lastPlayingTime && (now - gNowPlaying.lastPlayingTime > (Config.idleMinutes * 60 * 1000))) {
    gNowPlaying.isIdle = true;
    showPlayMeter(false);
  }

  return {data: gNowPlaying};
}

async function getRecentlyPlayed() {

  var res = await spotifyApi(spotifyRoutes.recentlyPlayed);
  if (res.error)
    return res;

  var data = res.data;
  debug(data);

  var rtrn = {};
  var now = Date.now();

  if (data && data.items) {
    var track = data.items[0].track;
    var album = track.album;
    var artist = getArtistName(track.artists);
    var albumImage = getAlbumImage(album.images);
    var date = getYearFromDate(album.release_date, album.release_date_precision);

    rtrn.type = track.type;  // e.g. 'track'
    rtrn.id = track.uri;     // track ID
    rtrn.track = track.name;
    rtrn.album = album.name;
    rtrn.artist = artist;
    rtrn.date = date;
    rtrn.explicit = track.explicit;
    rtrn.popularity = track.popularity;
    rtrn.albumImage = albumImage;
    rtrn.duration = track.duration_ms;
    rtrn.time = Date.now();
    rtrn.time = now;  // time of update
    debug(rtrn);
  }

  return {data: rtrn};
}

// tbd: seems to be getting artists that come up in 'radio'
async function getTopArtists(count = 10, range = 'medium_term') {
  var res = await spotifyApi(spotifyRoutes.topArtists, count, range);
  if (res.error)
    return res;

  var list = [];
  var data = res.data;

  if (data && data.items) {
    var items = data.items;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];

      var entry = {};
      entry.albumImage = getAlbumImage(item.images, false);
      entry.name = item.name;
      entry.genre = getGenre(item.genres);
      entry.followers = item.followers.total;
      entry.popularity = item.popularity;

      list.push(entry);
    }
  }

  return {data: list};
}

// this seems to be only getting tracks that you explicitly played
// either directly or by explicitly playing an album
// does not seem to include anything played through a 'radio', so sort or useless
async function getTopTracks(count = 10, range = 'medium_term') {
  var res = await spotifyApi(spotifyRoutes.topTracks, count, range);
  if (res.error)
    return res;

  var list = [];
  var data = res.data;

  if (data && data.items) {
    var items = data.items;
    for (var i = 0; i < items.length; i++) {
      var track = items[i];
      var album = track.album;

      var entry = {};
      entry.type = track.type;  // e.g. 'track'
      entry.id = track.uri;     // track ID
      entry.track = track.name;
      entry.album = album.name;
      entry.artist = getArtistName(track.artists);
      entry.date = getYearFromDate(album.release_date, album.release_date_precision);
      entry.explicit = track.explicit;
      entry.popularity = track.popularity;
      entry.albumImage = getAlbumImage(album.images, false);
      entry.duration = track.duration_ms;

      list.push(entry);
    }
  }

  return {data: list};
}

async function spotifyApiDirect(type, route) {
  if (!gAccessToken) {
    return {error: 'login'};
  }

  try {
    var res = await fetch(route, {method: type, headers: {Authorization: 'Bearer ' + gAccessToken, Accept: 'application/json', 'Content-Type': 'application/json'}});

    if ( res.status >= 200 && res.status < 300 )
    {
      // non-200's are a success call but have invalid data, e.g. not-playing
      if (res.status != 200)
        return {data: null};

      return {data: await res.json()};
    }

    // TODO: response.status 401 means expired token, might need to force server to renew
    return {error: `spotify: ${res.status}`};
  } catch(e) {
    return {error: `spotify: ${e.message}`};
  }    
}

async function spotifyApi(route, ...args) {
  var baseUri = 'https://api.spotify.com/v1/';
  var type = 'GET';
  var url = route;

  if (typeof(route) === 'object') {
    type = route.type;
    url = route.url;
  }

  url = format(url, args);
  
  return spotifyApiDirect(type, baseUri + url);
}


async function getLocal(route)
{
  try {
    var baseUri = Config.serverUrl;
    var res = await fetch(baseUri + route);

    if ( res.status == 200 ) {
      res = await res.json();
      if (res.error)
        return res;
      return {data: res};
    }

    return {error: `getLocal: ${res.status}`};
  } catch(e) {
    return {error: `getLocal: ${e.message}`};
  }
}

