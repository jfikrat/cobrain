const http = require('http');
const { exec } = require('child_process');

const PORT = 8888;
const HOST = '0.0.0.0';

// Termux environment
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';
const ENV = {
  PATH: TERMUX_BIN + ':/system/bin',
  LD_LIBRARY_PATH: '/data/data/com.termux/files/usr/lib',
  HOME: '/data/data/com.termux/files/home',
  PREFIX: '/data/data/com.termux/files/usr',
  TERMUX_VERSION: '0.118'
};

function termuxCmd(cmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    console.log('Executing:', cmd);

    const child = exec(cmd, {
      env: { ...process.env, ...ENV },
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024 // 50MB for base64 photos
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => {
      stderr += data;
      console.log('stderr:', data);
    });

    child.on('close', (code, signal) => {
      console.log('Command finished, code:', code, 'signal:', signal);
      if (code === 0) {
        resolve(stdout);
      } else if (signal === 'SIGTERM') {
        reject(new Error('Command timed out'));
      } else {
        reject(new Error(stderr || 'Command failed with code ' + code));
      }
    });

    child.on('error', err => {
      console.log('Command error:', err);
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { command, params } = JSON.parse(body);
        console.log('Command:', command, JSON.stringify(params));

        let result;
        switch(command) {
          case 'photo':
            const cam = params && params.camera === 'back' ? '1' : '0';
            const photoPath = '/sdcard/Download/photo_' + Date.now() + '.jpg';
            await termuxCmd('termux-camera-photo -c ' + cam + ' ' + photoPath, 60000);
            console.log('Photo taken, encoding...');
            const photoData = await termuxCmd('base64 ' + photoPath, 120000);
            console.log('Photo encoded, length:', photoData.length);
            result = { image: photoData.trim(), path: photoPath };
            break;

          case 'audio':
            const duration = (params && params.duration) || 5;
            const audioPath = '/sdcard/Download/audio_' + Date.now() + '.wav';
            await termuxCmd('termux-microphone-record -d -l ' + duration + ' -f ' + audioPath, (duration + 10) * 1000);
            result = { path: audioPath };
            break;

          case 'location':
            const locStr = await termuxCmd('termux-location -p network', 30000);
            const loc = JSON.parse(locStr);
            result = { lat: loc.latitude, lon: loc.longitude };
            break;

          case 'battery':
            const batStr = await termuxCmd('termux-battery-status', 10000);
            const bat = JSON.parse(batStr);
            result = { percentage: bat.percentage, status: bat.status, temperature: bat.temperature };
            break;

          case 'info':
            result = { time: new Date().toISOString() };
            break;

          default:
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Unknown command' }));
            return;
        }

        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Error:', err.message);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log('Phone agent running on http://' + HOST + ':' + PORT);
});
