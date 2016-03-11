/* jshint esversion: 6 */

Error.stackTraceLimit = Infinity;

try {
	var Discord = require("discord.js");
	var ytdl = require("ytdl-core");
	var Schlock = require("schlock");
	var fs = require("fs");
	var FFmpeg = require("fluent-ffmpeg");
	var through = require("through2");
} catch (e) {
	console.log("ERROR: Failed to load modules.");
	process.exit();
}

try {
	var globalAuth = require("./auth.json");
	var globalConfig = require("./config.json");
} catch (e) {
	console.log("ERROR: Failed to load authentication info or config.");
	process.exit();
}

var BotReaper = function(authentication, config) {
	var self = this;
	
	self.currentTrack = null;
	self.blockingTrack = null;
	self.playing = false;
	self.backlog = [];
	self.playlist = [];
	self.preloading = {};
	self.trackInfo = {};
	self.autoplay = false;
	self.advanceTimeout = null;
	self.progressInterval = null;
	self.dataLock = new Schlock();
	
	self.client = new Discord.Client();
	self.authentication = authentication;
	self.config = config;
	
	self.progressMessage = null;
	self.progressBlocks = 0;
	
	self.boundServer = null;
	self.boundMusicChannel = null;
	self.boundChannel = null;
	
	self.disconnectCallback = null;
	self.reconnected = false;
	
	self.wireCommands();
	self.wireConnectHandlers();
};

BotReaper.prototype.loadStatus = function(ready) {
	var self = this;
	var filePath = "./data.json";
	
	fs.exists(filePath, function (exists) {
		if (exists) {
			var composite = require(filePath);
			self.playlist = composite.playlist;
			self.trackInfo = composite.trackInfo;
			if (composite.hasOwnProperty("backlog")) {
				self.backlog = composite.backlog;
			}
		}
		
		ready();
	});
};

BotReaper.prototype.saveStatus = function() {
	var self = this;
	var composite = {"playlist": self.playlist, "trackInfo": self.trackInfo, "backlog": self.backlog};
	var filePath = "./data.json";
	
	self.dataLock.writeLock(filePath, function(lockError) {
		if (lockError) {
			console.log("ERROR: Could not lock file: " + lockError);
		} else {
			fs.writeFile(filePath, JSON.stringify(composite), function (error) {
				self.dataLock.writeUnlock(filePath, function (unlockError) {
					if (unlockError) {
						console.log("ERROR: Could not unlock file: " + unlockError);
					}
				});
				
				if (error) {
					console.log("ERROR: Could not write to status file: " + error);
				}
			});
		}
	});
};

BotReaper.prototype.selectFromPlaylist = function() {
	var self = this;
	
	if (self.playlist.length > 0) {
		return self.playlist[Math.floor(Math.random() * self.playlist.length)];
	}
	
	return null;
};

BotReaper.prototype.report = function(channel, message, callback) {
	var self = this;
	
	if (channel === null) {
		if (self.boundChannel === null) {
			return;
		}
		channel = self.boundChannel;
	}
	
	self.client.sendMessage(channel, message, callback);
};

BotReaper.prototype.findChannel = function(name, type) {
	var self = this;
	for (var channel of self.boundServer.channels) {
		if (channel instanceof type && channel.name === name) {
			return channel;
		}
	}
	return null;
};

BotReaper.prototype.trackProgress = function(ended) {
	var self = this;
	
	if (self.progressMessage === null || self.currentTrack === null) {
		return;
	}
	
	var total = self.currentTrack.info.lengthSeconds * 1000;
	var current = ended ? total : Math.min(Date.now() - self.currentTrack.startTime, total);
	
	if (total === 0) {
		return;
	}
	
	var progress = Math.floor(current / total * 50.0);
	if (self.progressBlocks === progress) {
		return;
	}
	
	var message = "``[" + self.repeat("\u25A0", progress) + self.repeat(" ", 50 - progress) + "]``";
	
	self.progressMessage.edit(message);
	self.progressBlocks = progress;
};

BotReaper.prototype.readyToRock = function() {
	var self = this;
	
	if (self.backlog.length > 0) {
		self.tryStartPlayback();
	}
	
	self.progressInterval = setInterval(self.trackProgress.bind(self), 2000);
	
	if (self.reconnected) {
		self.report(null, "Bot has reconnected after connection was lost.");
	} else {
		self.report(null, "Bot is ready to rock.");
	}
};

BotReaper.prototype.bindToServer = function(server) {
	var self = this;
	
	self.boundServer = server;
	console.log("INFO: Bound to server " + self.boundServer.id + ": " + self.boundServer.name);
	
	self.boundMusicChannel = self.findChannel(self.config.musicChannel, Discord.VoiceChannel);
	if (self.boundMusicChannel === null) {
		console.log("ERROR: Did not find a music channel with name: " + self.config.musicChannel);
		return;
	}
	
	self.boundChannel = self.findChannel(self.config.reportChannel, Discord.TextChannel);
	if (self.boundChannel === null) {
		console.log("ERROR: Did not find a text channel with name: " + self.config.reportChannel);
		return;
	}
	
	self.wireEventHandlers();
	self.readyToRock();
};

BotReaper.prototype.initialiseServer = function() {
	var self = this;
	
	if (self.client.servers.length === 0) {
		console.log("INFO: Not in any servers, using the link in config: " + self.config.serverInvite);
		
		self.client.joinServer(self.config.server, function(error, server) {
			if (error) {
				console.log("ERROR: Failed to join server: " + error);
			} else {
				console.log("INFO: Successfully followed the invite link.");
				
				self.bindToServer(server);
			}
		});
	} else {
		console.log("INFO: Already in a server, not following invite.");
		
		if (self.client.servers.length > 1) {
			console.log("WARNING: Multiple servers, only active in one.");
		}
		
		self.bindToServer(self.client.servers[0]);
	}
};

BotReaper.prototype.wireConnectHandlers = function() {
	var self = this;
	
	self.client.on("ready", function() {
		console.log("INFO: Connected to Discord server.");
		
		self.initialiseServer();
	});
	
	self.client.on("disconnected", function() {
		console.log("INFO: Disconnected from Discord server.");
		
		if (self.advanceTimeout !== null) {
			clearTimeout(self.advanceTimeout);
			self.advanceTimeout = null;
		}
		
		if (self.progressInterval !== null) {
			clearTimeout(self.progressInterval);
			self.progressInterval = null;
		}
		
		self.disconnectCallback();
	});
};

BotReaper.prototype.wireEventHandlers = function() {
	var self = this;

	self.client.on("message", function (message) {
		var command = self.extractCommand(message.content);
		
		if (command !== null) {
			if (!self.isValidCommandChannel(message.channel)) {
				console.log("INFO: Received command from non-command channel (" + message.channel.name + "): " + message.content);
			} else {
				console.log("INFO: Received command: " + message.content);
			
				if (self.commands.hasOwnProperty(command.command)) {
					self.commands[command.command].handler(message, command.param);
				}
			}
		}
	});
};

BotReaper.prototype.wireCommands = function() {
	var self = this;
	
	self.commands = {
		"queue": { handler: self.commandQueue.bind(self), example: "~queue [YT link]", description: "Adds the track to queue" },
		"now": { handler: self.commandNow.bind(self), example: "~now [YT link]", description: "Plays the track now" },
		"next": { handler: self.commandNext.bind(self), example: "~next", description: "Skips to the next track" },
		"backlog": { handler: self.commandBacklog.bind(self), example: "~backlog", description: "Lists currently queued tracks" },
		"help": { handler: self.commandHelp.bind(self), example: "~help", description: "Displays this command list" }
	};
};

BotReaper.prototype.isValidCommandChannel = function(channel) {
	var self = this;
	
	if (!(channel instanceof Discord.TextChannel)) {
		return false;
	} else if (channel.server.id !== self.boundServer.id) {
		return false;
	} else if (self.config.commandChannels.indexOf(channel.name) === -1) {
		return false;
	} else {
		return true;
	}
};

BotReaper.prototype.leadingZeroes = function(value, length) {
	var text = "" + value;
	while (text.length < length) {
		text = "0" + text;
	}
	return text;
};

BotReaper.prototype.formatSeconds = function(input) {
	var self = this;
	var hours = Math.floor(input / 3600);
	var minutes = Math.floor(input / 60) % 60;
	var seconds = input % 60;
	
	if (hours > 0) {
		return hours + ":" + self.leadingZeroes(minutes, 2) + ":" + self.leadingZeroes(seconds, 2);
	} else {
		return minutes + ":" + self.leadingZeroes(seconds, 2);
	}
};

BotReaper.prototype.sendLineList = function(channel, list, chunk) {
	var self = this;
	if (list.length <= chunk * 10) {
		return;
	}
	
	var slice = list.slice(chunk * 10, (chunk + 1) * 10).join("\n");
	self.client.sendMessage(channel, slice, function() {
		self.sendLineList(channel, list, chunk + 1);
	});
};

BotReaper.prototype.commandBacklog = function(message, param) {
	var self = this;
	var totalPlayTime = 0;
	var messageLines = [];
	var info;
	
	if (self.currentTrack !== null) {
		info = self.currentTrack.info;
		var secondsLeft = Math.max(1, Math.floor((self.currentTrack.startTime + info.lengthSeconds * 1000 - Date.now()) / 1000));
		messageLines.push(":musical_score: Now: [" + info.id + "] " + info.title + " (:clock330: " + self.formatSeconds(secondsLeft) + " remaining)");
		totalPlayTime += secondsLeft;
	}
	
	if (self.blockingTrack !== null) {
		info = self.trackInfo[self.blockingTrack];
		messageLines.push(":musical_score: Preparing: [" + info.id + "] " + info.title + " (:clock330: " + self.formatSeconds(info.lengthSeconds) + ")");
		totalPlayTime += info.lengthSeconds;
	}
	
	for (var i = 0; i < self.backlog.length; i++) {
		info = self.trackInfo[self.backlog[i]];
		messageLines.push(":musical_score: " + (i + 1) + ". [" + info.id + "] " + info.title + " (:clock330: " + self.formatSeconds(info.lengthSeconds) + ")");
		totalPlayTime += info.lengthSeconds;
	}
	
	messageLines.push(":watch: Total remaining playtime: " + self.formatSeconds(totalPlayTime));
	
	self.sendLineList(message.channel, messageLines, 0);
};

BotReaper.prototype.getTrackFilePath = function(id, extension) {
	var self = this;
	return self.config.musicDir + "/" + id + extension;
};

BotReaper.prototype.repeat = function(str, num) {
	num = Number(num);

	var result = "";
	while (true) {
		if (num & 1) {
			result += str;
		}
		num >>>= 1;
		if (num <= 0) break;
		str += str;
	}

	return result;
};

BotReaper.prototype.trackFinished = function() {
	var self = this;
	self.trackProgress(true);
	self.tryStartPlayback();
};

BotReaper.prototype.startPlayback = function(filePath, trackInfo) {
	var self = this;
	
	if (self.playing) {
		return;
	}
	
	self.playing = true;
	self.blockingTrack = null;
	
	console.log("INFO: Joining voice channel " + self.boundMusicChannel);
	
	self.client.joinVoiceChannel(self.boundMusicChannel, function(joinError, channel) {
		if (joinError) {
			console.log("ERROR: Could not join voice channel: " + joinError);
		} else {
			console.log("INFO: Playing file " + filePath);
			
			self.client.voiceConnection.playFile(filePath);
			self.report(null, "Now playing: " + trackInfo.title + " (" + trackInfo.id + ")", function(messageError) {
				if (messageError) {
					console.log("ERROR: Could not create now playing message: " + messageError);
				}
			
				self.report(null, "``[" + self.repeat(" ", 50) + "]``", function(progressError, message) {
					if (!progressError) {
						self.progressMessage = message;
						self.progressBlocks = 0;
					} else {
						console.log("ERROR: Could not create progress message: " + progressError);
					}
				});
			});
			
			self.currentTrack = { info: trackInfo, startTime: Date.now() };
			self.advanceTimeout = setTimeout(self.trackFinished.bind(self), trackInfo.lengthSeconds * 1000);
			
			console.log("INFO: Setting timeout for triggering next track: " + (trackInfo.lengthSeconds + 1) * 1000);
		}
	});
	
	self.preloadNextTrack();
};

BotReaper.prototype.markTrackLoadFailed = function(trackInfo) {
	var self = this;
	self.report(null, "Failed to preload track: " + trackInfo.title + " (" + trackInfo.id + "s).");
	
	var blocking = self.blockingTrack === trackInfo.id;
	var backlogPosition;
	
	while ((backlogPosition = self.backlog.indexOf(trackInfo.id)) >= 0) {
		self.backlog.splice(backlogPosition);
	}
	
	if (self.blockingTrack == trackInfo.id) {
		self.blockingTrack = null;
	}
	
	if (blocking) {
		self.tryStartPlayback();
	}
};

BotReaper.prototype.preloadTrack = function (trackInfo, eagerLoad) {
	var self = this;
	var markerFile = self.getTrackFilePath(trackInfo.id, ".complete");
	var trackFile = self.getTrackFilePath(trackInfo.id, ".track");

	if (self.preloading.hasOwnProperty(trackInfo.id)) {
		console.log("INFO: Track " + trackInfo.id + " is already in the middle of preloading.");
		return;
	}
	
	fs.exists(markerFile, function(exists) {
		if (exists) {
			console.log("INFO: Track " + trackInfo.id + " already cached, no preload necessary.");
			
			self.tryStartPlaybackIfStopped();
			return;
		}
		
		console.log("INFO: Starting to preload track " + trackInfo.id + ".");
		
		self.preloading[trackInfo.id] = true;
	
		self.downloadYoutubeTrack(trackInfo.id, trackFile, function() {
			console.log("INFO: Preload of track " + trackInfo.id + " finished.");
			
			fs.open(markerFile, "w", function (error, fd) {
				if (error) {
					console.log("ERROR: Failed to write marker file: " + error);
				} else {
					console.log("INFO: Wrote completed marker for track " + trackInfo.id + ".");
				}
			
				fs.close(fd, function (err) {
					delete self.preloading[trackInfo.id];
					
					if (self.blockingTrack == trackInfo.id) {
						console.log("INFO: Preload triggering play, playback blocked behind track " + trackInfo.id + ".");
						
						self.tryStartPlayback();
					} else {
						console.log("INFO: Preload not triggering play, playback not blocked behind track " + trackInfo.id + ".");
					}
				});
			});
		}, function(data) {
			console.log("INFO: Received info for preloaded track " + trackInfo.id + " - title: " + trackInfo.title);
			
			if (data["length_seconds"] > 10950) {
				return false;
			} else {
				//if (!eagerLoad) {
					self.report(null, "Preloading track: " + trackInfo.title + " (" + trackInfo.id + ").");
				//}
				return true;
			}
		}, function() {
			delete self.preloading[trackInfo.id];
			
			fs.exists(trackFile, function (present) {
				if (present) {
					fs.unlink(trackFile);
				}
			});
			
			self.markTrackLoadFailed(trackInfo);
		});
	});
};

BotReaper.prototype.preloadNextTrack = function() {
	var self = this;
	if (self.backlog.length !== 0) {
		self.preloadTrack(self.trackInfo[self.backlog[0]], true);
	}
};

BotReaper.prototype.tryStartPlaybackIfStopped = function() {
	var self = this;
	
	if (!self.playing) {
		self.tryStartPlayback();
	}
};

BotReaper.prototype.tryStartPlayback = function() {
	var self = this;
	var trackInfo = null;
	var markerFile = null;
	
	console.log("INFO: Attempting to start playback.");
	
	self.progressMessage = null;
	
	if (self.advanceTimeout !== null) {
		clearTimeout(self.advanceTimeout);
		self.advanceTimeout = null;
	}
	
	if (self.client.voiceConnection !== null) {
		self.currentTrack = null;
		self.client.voiceConnection.stopPlaying();
	}
	
	self.playing = false;
	
	if (self.blockingTrack !== null) {
		console.log("INFO: Trying to start blocking track " + self.blockingTrack);
		
		trackInfo = self.trackInfo[self.blockingTrack];
		markerFile = self.getTrackFilePath(trackInfo.id, ".complete");

		if (!self.preloading.hasOwnProperty(trackInfo.id)) {
			fs.exists(markerFile, function(presence) {
				if (presence) {
					self.startPlayback(self.getTrackFilePath(trackInfo.id, ".track"), trackInfo);
				}
			});
		} else {
			console.log("INFO: Blocking track is already being preloaded " + self.blockingTrack);
		}
	} else if (self.backlog.length === 0) {
		if (self.autoplay === true) {
			var track = self.selectFromPlaylist();
			
			if (track === null) {
				self.report(null, "Queue ended, no tracks in playlist.");
			} else {
				self.queueTrack(null, track, true, false);
			}
		} else {
			self.report(null, "Queue ended, autoplay disabled.");
		}
	} else {
		var selected = self.backlog.shift();
		trackInfo = self.trackInfo[selected];
		
		self.saveStatus();
		
		self.blockingTrack = selected;
		
		if (!self.preloading.hasOwnProperty(selected)) {
			markerFile = self.getTrackFilePath(trackInfo.id, ".complete");
			
			fs.exists(markerFile, function(presence) {
				if (presence) {
					self.startPlayback(self.getTrackFilePath(trackInfo.id, ".track"), trackInfo);
				} else {
					self.preloadTrack(trackInfo, false);
				}
			});
		} else {
			self.report(null, "Waiting for preload: " + trackInfo.title + " (" + trackInfo.id + ")");
		}
	}
};

BotReaper.prototype.getTrackInfo = function (trackId, success, failure) {
	var self = this;
	
	if (self.trackInfo.hasOwnProperty(trackId)) {
		console.log("INFO: Collected new track info: " + self.trackInfo[trackId]);
		success(self.trackInfo[trackId]);
	} else {
		try {
			ytdl.getInfo("http://www.youtube.com/watch?v=" + trackId, {}, function(error, info) {		
				if (error) {
					console.log("ERROR: Failed to get track info: " + error);
				
					failure("Track does not exist or is geoblocked");
				} else {
					var trackInfo = { "id": trackId, "title": info.title, "lengthSeconds": parseInt(info.length_seconds) };
					
					if (trackInfo.lengthSeconds > 10950) {
						failure("Track is longer than an hour.");
					} else {
						self.trackInfo[trackId] = trackInfo;
						self.saveStatus();
						
						success(trackInfo);
					}
				}
			});
		}
		catch (e) {
			console.log("ERROR: Invalid track ID");
		}
	}
};

BotReaper.prototype.queueTrack = function (channel, trackId, automatical, beginning) {
	var self = this;
	
	self.getTrackInfo(trackId, function(trackInfo) {
		if (beginning) {
			console.log("INFO: Queueing track " + trackInfo.id + " to the end.");
			self.report(channel, "Queued for instant play: " + trackInfo.title + " (" + trackInfo.id + ")");
		} else {
			console.log("INFO: Queueing track " + trackInfo.id + " to the beginning.");
			self.report(channel, (automatical ? "Auto-queued" : "Queued") + " : " + trackInfo.title + " (" + trackInfo.id + ") to position " + (self.backlog.length + 1));
		}
		
		if (beginning) {
			self.backlog.unshift(trackInfo.id);
		} else {
			self.backlog.push(trackInfo.id);
		}
		
		self.saveStatus();

		if (beginning) {
			self.tryStartPlayback();
		} else {
			self.tryStartPlaybackIfStopped();
		}
		
		if (self.backlog.length === 1) {
			console.log("INFO: Queued track is first in backlogm, triggering preload.");
			self.preloadNextTrack();
		} else {
			console.log("INFO: New queue size is " + self.backlog.length + ", no need to preload current.");
		}
	}, function(errorText) {
		self.report(channel, "Could not " + (automatical ? "auto-queue" : "queue") + " " + trackId + ": " + errorText);
	});
};

BotReaper.prototype.commandHelp = function(message, param) {
	var self = this;
	var response = "";
	
	for (var name in self.commands) {
		var command = self.commands[name];
		response += "**`" + command.example + "`**\n" + command.description + "\n";
	}
	
	self.client.sendMessage(message.channel, response);
};

BotReaper.prototype.streamYoutubeAudio = function (url, failure) {
	var options = {
		videoFormat: "mp4",
		quality: "lowest",
		audioFormat: "mp3"
	};
	
	var stream = through();
	stream.on("error", failure);
	
	var video = ytdl(url, { filter: function(format) {
		return format.container === options.videoFormat;
	}, quality: options.quality });
	
	video.on("info", function (info, format) {
		stream.emit("info", info, format);
	});
	
	var ffmpeg = new FFmpeg(video);
	
	var output = ffmpeg
		.format(options.audioFormat)
		.on("error", stream.emit.bind(stream, "error"))
		.pipe(stream);
	
	var ended = false;
	stream.on("error", function() {
		if (!ended) {
			ended = true;
			video.end();
		}
	});
	
	return stream;
};

BotReaper.prototype.downloadYoutubeTrack = function (id, filePath, success, info, failure) {
	var self = this;
	var reported = false;
	
	var stream = self.streamYoutubeAudio("http://www.youtube.com/watch?v=" + id, function() {
		if (!reported) {
			reported = true;
			failure();
		}
	});
	
	var hadError = false;
	
	stream.on("error", function() {
		hadError = true;
	});
	
	stream.on("info", function(data) {
		if (!info(data)) {
			stream.end();
			hadError = true;
		}
	});
	
	stream.on("end", function() {
		if (hadError) {
			if (!reported) {
				reported = true;
				failure();
			}
		} else {
			success();
		}
	});
	
	var output = fs.createWriteStream(filePath);
	
	output.on("error", function() {
		if (!reported) {
			reported = true;
			failure();
		}
	});
	
	stream.pipe(output);
};

BotReaper.prototype.extractYoutubeTrackId = function (text) {
	var id = text;
	
	if (text.indexOf("http") === 0) {
		var result = /(youtu\.be\/|youtube\.com\/(watch\?(.*&)?v=|(embed|v)\/))([^\?&"'>]+)/.exec(id);
	
		if (result === null) {
			return null;
		}
		
		id = result[5];
	}
	
	return id;
};

BotReaper.prototype.commandQueue = function(message, param) {
	var self = this;
	var id = self.extractYoutubeTrackId(param);
	
	if (id === null) {
		self.client.sendMessage(message.channel, "Not a valid address");
		return;
	}
	
	self.queueTrack(message.channel, id, false, false);
};

BotReaper.prototype.commandNow = function(message, param) {
	var self = this;
	var id = self.extractYoutubeTrackId(param);
	
	if (id === null) {
		self.client.sendMessage(message.channel, "Not a valid address");
		return;
	}
	
	self.queueTrack(message.channel, id, false, true);
};

BotReaper.prototype.commandNext = function(message, param) {
	var self = this; 
	self.tryStartPlayback();
};

BotReaper.prototype.extractCommand = function(text) {
	if (text[0] !== '~') {
		return null;
	}
	
	var space = text.indexOf(" ");
	
	var param = "";
	var command = text.substring(1);
	
	if (space !== -1) {
		command = text.substring(1, space);
		param = text.substring(space + 1);
	}
	
	return { command: command, param: param };
};

BotReaper.prototype.start = function(reconnected, disconnectCallback) {
	var self = this;
	
	self.reconnected = reconnected;
	self.disconnectCallback = disconnectCallback;
	self.loadStatus(function () {
		self.client.login(self.authentication.email, self.authentication.password, function(error, token) {
			if (error) {
				console.log("ERROR: Failed to login: " + error);
				
				self.disconnectCallback();
			} else {
				console.log("INFO: Logged in with token: " + token);
			}
		});
	});
};

/*process.on("uncaughtException", function (error) {
	console.log(error.stack);
});*/

var botReaper = new BotReaper(globalAuth, globalConfig);
var reconnector = function() {
	console.log("INFO: Reconnecting in 3 seconds.");

	setTimeout(function() {
		botReaper = new BotReaper(globalAuth, globalConfig);
		botReaper.start(true, reconnector);
	}, 3000);
};
botReaper.start(false, reconnector);
