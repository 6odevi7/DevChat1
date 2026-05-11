<?php
// DevChat persistent backend.
// Stores users / posts / messages in ./data/state.json so accounts and
// content survive across browsers and deployments.

@ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Try to use a local ./data folder first; if that's not writable (common on
// shared hosts where PHP cannot write into the public webroot subdir), fall
// back to the system temp directory so the API still works.
function pickDataDir() {
    $candidates = [__DIR__ . '/data', sys_get_temp_dir() . '/devchat-data'];
    foreach ($candidates as $dir) {
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        if (is_dir($dir) && is_writable($dir)) return $dir;
    }
    return null;
}

$dataDir = pickDataDir();
if (!$dataDir) {
    http_response_code(500);
    echo json_encode([
        'error' => 'no writable data directory',
        'hint'  => 'chmod 0775 the DevChat folder so PHP can create ./data/state.json',
        'tried' => [__DIR__ . '/data', sys_get_temp_dir() . '/devchat-data']
    ]);
    exit;
}
$stateFile = $dataDir . '/state.json';

// Health check / diagnostic endpoint — visit api.php directly in a browser.
if (($_GET['action'] ?? '') === 'health' || $_SERVER['REQUEST_METHOD'] === 'GET' && empty($_GET['action'])) {
    echo json_encode([
        'ok'         => true,
        'php'        => PHP_VERSION,
        'dataDir'    => $dataDir,
        'stateFile'  => $stateFile,
        'writable'   => is_writable($dataDir),
        'fileExists' => file_exists($stateFile),
        'fileSize'   => file_exists($stateFile) ? filesize($stateFile) : 0
    ]);
    exit;
}

function emptyState() {
    return ['users' => [], 'posts' => [], 'messages' => [], 'seeded' => false];
}

function loadState($file) {
    if (!file_exists($file)) return emptyState();
    $raw = @file_get_contents($file);
    if (!$raw) return emptyState();
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) return emptyState();
    return array_merge(emptyState(), $decoded);
}

function withLock($file, $callback) {
    $fp = fopen($file, 'c+');
    if (!$fp) return null;
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $state = json_decode($raw, true);
    if (!is_array($state)) $state = emptyState();
    $state = array_merge(emptyState(), $state);
    $result = $callback($state);
    if ($result['save'] ?? false) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($result['state'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $result['return'] ?? null;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

// Body can arrive as:
//   1. raw JSON in the request body (POST)
//   2. ?data=<urlencoded JSON> or POST['data']
//   3. ?b64=<base64 url-safe JSON>  (avoids WAF rules that block { } " in URLs)
$rawBody = file_get_contents('php://input');
$body = json_decode($rawBody, true);
if (!is_array($body)) {
    $alt = $_POST['data'] ?? $_GET['data'] ?? '';
    if ($alt !== '') {
        $decoded = json_decode($alt, true);
        if (is_array($decoded)) $body = $decoded;
    }
}
if (!is_array($body)) {
    $b64 = $_POST['b64'] ?? $_GET['b64'] ?? '';
    if ($b64 !== '') {
        // Accept both standard and url-safe base64.
        $b64 = strtr($b64, '-_', '+/');
        $pad = strlen($b64) % 4;
        if ($pad) $b64 .= str_repeat('=', 4 - $pad);
        $json = base64_decode($b64, true);
        if ($json !== false) {
            $decoded = json_decode($json, true);
            if (is_array($decoded)) $body = $decoded;
        }
    }
}
if (!is_array($body)) $body = [];

switch ($action) {
    case 'state': {
        echo json_encode(loadState($stateFile));
        break;
    }
    case 'signup': {
        $user = $body['user'] ?? null;
        if (!is_array($user) || empty($user['username']) || empty($user['email'])) {
            http_response_code(400);
            echo json_encode(['error' => 'missing fields']);
            break;
        }
        $result = withLock($stateFile, function ($state) use ($user) {
            foreach ($state['users'] as $existing) {
                if (strcasecmp($existing['username'], $user['username']) === 0
                    || strcasecmp($existing['email'], $user['email']) === 0) {
                    return ['save' => false, 'return' => ['error' => 'exists']];
                }
            }
            $state['users'][] = $user;
            return ['save' => true, 'state' => $state, 'return' => ['user' => $user]];
        });
        if (isset($result['error'])) http_response_code(409);
        echo json_encode($result ?? ['error' => 'write failed']);
        break;
    }
    case 'login': {
        $identity = strtolower(trim($body['identity'] ?? ''));
        if ($identity === '') {
            http_response_code(400);
            echo json_encode(['error' => 'missing identity']);
            break;
        }
        $state = loadState($stateFile);
        $found = null;
        foreach ($state['users'] as $u) {
            if (strtolower($u['username']) === $identity || strtolower($u['email']) === $identity) {
                $found = $u;
                break;
            }
        }
        if (!$found) {
            http_response_code(404);
            echo json_encode(['error' => 'not found']);
            break;
        }
        echo json_encode(['user' => $found]);
        break;
    }
    case 'post': {
        $post = $body['post'] ?? null;
        if (!is_array($post) || empty($post['id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'missing post']);
            break;
        }
        $result = withLock($stateFile, function ($state) use ($post) {
            array_unshift($state['posts'], $post);
            $state['posts'] = array_slice($state['posts'], 0, 500);
            return ['save' => true, 'state' => $state, 'return' => ['post' => $post]];
        });
        echo json_encode($result ?? ['error' => 'write failed']);
        break;
    }
    case 'message': {
        $message = $body['message'] ?? null;
        if (!is_array($message) || empty($message['id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'missing message']);
            break;
        }
        $result = withLock($stateFile, function ($state) use ($message) {
            $state['messages'][] = $message;
            $state['messages'] = array_slice($state['messages'], -300);
            return ['save' => true, 'state' => $state, 'return' => ['message' => $message]];
        });
        echo json_encode($result ?? ['error' => 'write failed']);
        break;
    }
    case 'seed': {
        $seed = $body['state'] ?? null;
        if (!is_array($seed)) {
            http_response_code(400);
            echo json_encode(['error' => 'missing state']);
            break;
        }
        $result = withLock($stateFile, function ($state) use ($seed) {
            if (!empty($state['seeded'])) {
                return ['save' => false, 'return' => ['ok' => false, 'state' => $state]];
            }
            $merged = array_merge($state, $seed);
            $merged['seeded'] = true;
            return ['save' => true, 'state' => $merged, 'return' => ['ok' => true, 'state' => $merged]];
        });
        echo json_encode($result ?? ['error' => 'write failed']);
        break;
    }
    default:
        http_response_code(400);
        echo json_encode(['error' => 'unknown action']);
}
