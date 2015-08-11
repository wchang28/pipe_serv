var net = require('net');

//var PIPE_ENTRY_POINT_ADDRESS = '192.168.1.9';
var PIPE_ENTRY_POINT_ADDRESS = '192.168.1.8';
//var RDP_HOST_ADDRESS = '192.168.1.2';
var RDP_HOST_ADDRESS = '127.0.0.1';

var PIPE_PORT = 6000;
var RDP_PORT = 3389;

var REMOTE_DATA = 0
var REMOTE_INITIATE_CONNECT = 1;
var REMOTE_INITIATE_DISCONNECT = 2;
var REMOTE_CONNECTED = 3;

var socketPipe = null;
var state = 'idle';
var receiveFrameBuffer = null;
var socketRDPHost = null;
var dataBuffer = [];

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

function changeStateToPipeOpened() {
	receiveFrameBuffer = null;
	dataBuffer = [];
	if (socketRDPHost != null) {
		socketRDPHost.end();
		socketRDPHost = null;
	}
	state = 'pipe_opened';
	console.log('state = ' + state);
}

function changeStateToRDPConnected() {
	console.log('connected to RDP host');
	pipeSendCommand(socketPipe, REMOTE_CONNECTED);	// notify the other side of the pipe that we have successfully connected to the RDP host
	state = 'rdp_connect';
	console.log('state = ' + state);
	if (dataBuffer.length > 0) {
		for (var i in dataBuffer)
			socketRDPHost.write(dataBuffer[i]);
		dataBuffer = [];
	}
}

console.log('connecting to the pipe entry point server @ ' + PIPE_ENTRY_POINT_ADDRESS + ':' + PIPE_PORT + '...');

socketPipe = net.connect({host: PIPE_ENTRY_POINT_ADDRESS, port: PIPE_PORT}
,function() {
	console.log('connected to the pipe entry point server @ ' + socketPipe.remoteAddress + ' :-)');
	socketPipe.setKeepAlive(true);	// keep the pipe alive
	changeStateToPipeOpened();
});

function onReceivedFrameFromPipe(cmd, frameData) {
	if (cmd == REMOTE_INITIATE_CONNECT) {
		console.log('received a REMOTE_INITIATE_CONNECT frame. initiatiating connection to the RDP host @ ' + RDP_HOST_ADDRESS + '...');
		socketRDPHost = net.connect({host: RDP_HOST_ADDRESS, port: RDP_PORT}
		,function() {
			// connected to RDP host
			changeStateToRDPConnected();
		});
		socketRDPHost.on('data', function(data) {
			// received data from RDP host
			console.log('received data of ' + data.length + ' byte(s) from socketRDPHost');
			pipeSendData(socketPipe, data);	// forward data to the pipe
		});
		socketRDPHost.on('error', function(err) {
			console.log('! socketRDPHost.on_error(err=' + err.toString() +')');
			// on_close(true) will be called next
		});
		socketRDPHost.on('end', function() {
			console.log('socketRDPHost.on_end()');
			// on_close(false) will be called next
		});
		socketRDPHost.on('close', function(had_error) {
			console.log('socketRDPHost.on_close(had_error=' + had_error + ')');
			if (state !== 'pipe_opened') {
				console.log('sending REMOTE_INITIATE_DISCONNECT frame');
				pipeSendCommand(socketPipe, REMOTE_INITIATE_DISCONNECT);
				socketRDPHost = null;
				changeStateToPipeOpened();
			}
		});
	}
	else if (cmd == REMOTE_INITIATE_DISCONNECT) {
		console.log('received a REMOTE_INITIATE_DISCONNECT frame');
		if (state !== 'pipe_opened') changeStateToPipeOpened();
	}
	else if (cmd == REMOTE_DATA) {
		var frameLength = frameData.length;
		if (state === 'rdp_connect' && socketRDPHost != null)
			socketRDPHost.write(frameData);
		else {
			console.log('received data from the pipe before RDP connection is established to the host');
			console.log('put data of ' + frameLength + ' byte(s) into a temporary buffer first');
			dataBuffer.push(frameData);
		}
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
});

socketPipe.on('error', function(err) {
	console.log('! socketPipe.on_error(err=' + err.toString() +')');
	// on_close(true) will be called next
});

socketPipe.on('end', function() {
	console.log('socketPipe.on_end()');
	// on_close(false) will be called next
});

socketPipe.on('close', function(had_error) {
	console.log('socketPipe.on_close(had_error=' + had_error + ')');
	process.exit(1);
});
