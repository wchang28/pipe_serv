var net = require('net');
var fs = require('fs');
var os = require('os');

var DEFAULT_SERVICE_NAME = 'Pipe Entry Point Service';

var REMOTE_DATA = 0;
var REMOTE_INITIATE_CONNECT = 1;
var REMOTE_INITIATE_DISCONNECT = 2;
var REMOTE_CONNECTED = 3;

// argv[2] is config file
if (process.argv.length < 3) {
	console.error('config file is not optional');
	process.exit(1);
}

var config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
//console.log(JSON.stringify(config));

var serviceName = (config['serviceName'] ? config['serviceName'] : DEFAULT_SERVICE_NAME);

var PIPE_PORT = config['pipePort'];
var RDP_PORT = config['rdpPort'];

var notificationConfig = config["rest_notification"];
notificationConfig = (notificationConfig ? notificationConfig : null);
var sendNotificationMsg = (notificationConfig != null);
if (sendNotificationMsg) {
	if (!notificationConfig["protocol"]) {
		console.error('missing "protocol" in notification config');
		process.exit(1);
	}
	if (!notificationConfig["options"]) {
		console.error('missing "options" in notification config');
		process.exit(1);
	}
}

var serverPipe = net.createServer();
var serverRDP = net.createServer();
var state = 'idle';
var socketPipe = null;
var socketRDPClient = null;
var receiveFrameBuffer = null;

function pipeSendCommand(pipe, cmd) {
	if (pipe) {
		var header = new Buffer(5);
		header[0] = cmd;
		header.writeUInt32BE(0x00000000, 1, 4);
		console.log('writing ' + header.length + ' byte(s) to the pipe');
		pipe.write(header);
	}
}

function pipeSendData(pipe, data) {
	if (pipe) {
		var header = new Buffer(5);
		header[0] = REMOTE_DATA;
		header.writeUInt32BE(data.length, 1, 4);
		var b = Buffer.concat([header, data]);
		console.log('writing ' + b.length + ' byte(s) to the pipe');
		pipe.write(b);
	}
}

function getStatusObject() {
	var ret =
	{
		"name": serviceName
		,"hostname": os.hostname()
		,"pid": process.pid
		,"state": "STARTED"
		,"time": new Date().toString()
		,"pipe":
		{
			"state": state
		}
	};
	return ret;
}

function sendNotification(statusObj, onDone) {
	var protocol = notificationConfig["protocol"];
	var options = notificationConfig["options"];
	var httpModule = require(protocol);
	var req = httpModule.request(options, function(res) {
		//console.log("statusCode: ", res.statusCode);
		//console.log("headers: ", res.headers);
		res.setEncoding('utf8');
		var s = "";
		res.on('data', function(d) {
			//process.stdout.write(d);
			s += d;
		});
		res.on('end', function() {
			try {
				if (res.statusCode != 200) throw "http returns status code of " + res.statusCode;
				var o = JSON.parse(s);
				if (o.exception) throw o.exception;
				if (typeof onDone === 'function') onDone(null, o.receipt_id);
			} catch(e) {
				if (typeof onDone === 'function') onDone(e, null);
			}
		});
	});
	req.on('error', function(e) {
		if (typeof onDone === 'function') onDone(e, null);
	});
	var o = {"headers": {}, "message": JSON.stringify(statusObj)};
	req.end(JSON.stringify(o));
}

function onSendNotificationDone(err, receipt_id) {
	if (err) console.error('!!! error sending notification: ' + err.toString());
	else console.log('notification sent successfully, receipt_id=' + receipt_id);	
}

function serverPipeListen() {
	console.log('pipe entry point server listening on port ' + PIPE_PORT + '...');
	serverPipe.listen(PIPE_PORT);
}

function serverRDPListen() {
	console.log('RDP server listening on port ' + RDP_PORT);
	serverRDP.listen(RDP_PORT);
}

function changeStateToIdle() {
	receiveFrameBuffer = null;
	socketPipe = null;
	if (socketRDPClient != null) {
		socketRDPClient.end();
		socketRDPClient = null;
	}
	serverPipeListen();
	state = 'idle';
	console.log('state = ' + state);
	if (sendNotificationMsg) sendNotification(getStatusObject(), onSendNotificationDone);
}

function changeStateToPipeOpened() {
	receiveFrameBuffer = null;
	if (socketRDPClient != null) {
		socketRDPClient.end();
		socketRDPClient = null;
	}
	serverRDPListen();
	state = 'pipe_opened';
	console.log('state = ' + state);
	if (sendNotificationMsg) sendNotification(getStatusObject(), onSendNotificationDone);
}

serverRDP.on('connection', function(socket) {
	// remote desktop client connected
	console.log('remote desktop client connected');
	serverRDP.close();
	socketRDPClient = socket;
	socketRDPClient.on('error', function(err) {
		console.log('! socketRDPClient.on_error(err=' + err.toString() +')');
		// on_close(true) will be called next
	});
	socketRDPClient.on('end', function() {
		console.log('socketRDPClient.on_end()');
		// on_close(false) will be called next
	})
	socketRDPClient.on('close', function(had_error) {
		console.log('socketRDPClient.on_close(had_error=' + had_error + ')');
		if (state !== 'pipe_opened') {
			console.log('sending REMOTE_INITIATE_DISCONNECT frame');
			pipeSendCommand(socketPipe, REMOTE_INITIATE_DISCONNECT);
			socketRDPClient = null;
			changeStateToPipeOpened();
		}
	})
	socketRDPClient.on('data', function(data) {
		// received data from the RDP client
		console.log('received data of ' + data.length + ' byte(s) from socketRDPClient');
		pipeSendData(socketPipe, data);	// forward data to the pipe
	})
	state = 'rdp_connect';
	//send 'REMOTE_INITIATE_CONNECT' frame to socketPipe
	console.log('sending REMOTE_INITIATE_CONNECT frame');
	pipeSendCommand(socketPipe, REMOTE_INITIATE_CONNECT);
});

serverPipe.on('connection', function(socket) {
	console.log('pipe exit point @ ' + socket.remoteAddress + ' connected');
	serverPipe.close();
	socketPipe = socket;
	socketPipe.on('close', function(had_error) {
		console.log('socketPipe.on_close(had_error=' + had_error + ')');
		changeStateToIdle();
	})
	socketPipe.on('end', function() {
		console.log('socketPipe.on_end()');
		// on_close(false) will be called next
	})
	socketPipe.on('error', function(err) {
		console.log('! socketPipe.on_error(err=' + err.toString() +')');
		// on_close(true) will be called next
	});
	function onReceivedFrameFromPipe(cmd, frameData) {
		if (cmd == REMOTE_DATA && socketRDPClient != null && frameData != null) {
			socketRDPClient.write(frameData);
		}
		else if (cmd == REMOTE_CONNECTED) {
			console.log('pipe exit point reports RDP connection to the destination host is successful');
		}
		else if (cmd == REMOTE_INITIATE_DISCONNECT) {
			console.log('received a REMOTE_INITIATE_DISCONNECT frame');
			if (state !== 'pipe_opened') changeStateToPipeOpened();
		}
	}
	socketPipe.on('data', function(data) {
		console.log('received ' + data.length + ' byte(s) from the pipe');
		receiveFrameBuffer = (receiveFrameBuffer == null ? data : Buffer.concat([receiveFrameBuffer, data]));
		function onReceiveFrameBufferChanged(onReceivedFrame) {
			if (receiveFrameBuffer != null && receiveFrameBuffer.length >= 5) {
				var frameDataLength = receiveFrameBuffer.readUInt32BE(1, 4);
				var contentLength = receiveFrameBuffer.length - 5;
				if (contentLength >= frameDataLength)	{// fully receive a frame
					var frameData = null;
					if (frameDataLength > 0) frameData = new Buffer(receiveFrameBuffer.slice(5, 5 + frameDataLength));
					var cmd = receiveFrameBuffer[0];
					onReceivedFrame(cmd, frameData);
					if (contentLength == frameDataLength)
						receiveFrameBuffer = null;
					else // contentLength > frameDataLength
						receiveFrameBuffer = new Buffer(receiveFrameBuffer.slice(5+frameDataLength));
					onReceiveFrameBufferChanged(onReceivedFrame);					
				}
			}
		}
		onReceiveFrameBufferChanged(onReceivedFrameFromPipe);
	})

	changeStateToPipeOpened();
});

changeStateToIdle();

