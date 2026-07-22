use assert_cmd::Command;
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

struct Mock {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    thread: thread::JoinHandle<()>,
}

impl Mock {
    fn start(responses: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/graphql", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let thread = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                seen.lock().unwrap().push(request);
                let body = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    response
                );
                stream.write_all(body.as_bytes()).unwrap();
            }
        });
        Self {
            endpoint,
            requests,
            thread,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let n = stream.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if bytes.windows(4).any(|x| x == b"\r\n\r\n") {
            let headers_end = bytes.windows(4).position(|x| x == b"\r\n\r\n").unwrap() + 4;
            let headers = String::from_utf8_lossy(&bytes[..headers_end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    (name.eq_ignore_ascii_case("content-length"))
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while bytes.len() < headers_end + length {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
            break;
        }
    }
    String::from_utf8(bytes).unwrap()
}

#[test]
fn api_sends_auth_graphql_variables_and_paginates() {
    let mock = Mock::start(vec![
        r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","title":"第一"}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}}}"#.into(),
        r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-2","title":"第二"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#.into(),
    ]);
    let output = Command::cargo_bin("magi-linear-axi").unwrap()
        .args(["--format", "json", "--endpoint", &mock.endpoint, "api", "query Issues($filter:IssueFilter,$after:String){issues{nodes{identifier title}pageInfo{hasNextPage endCursor}}}", "--variable", "filter={\"title\":{\"containsIgnoreCase\":\"x\"}}", "--paginate"])
        .env("LINEAR_API_KEY", "lin_api_test")
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["issues"]["nodes"].as_array().unwrap().len(), 2);
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: lin_api_test")
    );
    assert!(requests[0].contains("\"filter\": {"));
    assert!(requests[1].contains("\"after\": \"next\""));
    mock.thread.join().unwrap();
}

#[test]
fn api_error_is_json_stdout_and_exit_two_for_usage() {
    let output = Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["--format", "json", "api"])
        .env("LINEAR_API_KEY", "lin_api_test")
        .write_stdin("")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], 2);
    assert!(!output.stderr.is_empty());
}

#[test]
fn setup_is_idempotent_preserves_config_and_installs_session_plugins() {
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "model = \"x\"\n[features]\nother = true\n").unwrap();
    for _ in 0..2 {
        Command::cargo_bin("magi-linear-axi")
            .unwrap()
            .args(["setup"])
            .env("HOME", home.path())
            .env("LINEAR_API_KEY", "unused")
            .assert()
            .success();
    }
    let claude: Value = serde_json::from_str(
        &std::fs::read_to_string(home.path().join(".claude/settings.json")).unwrap(),
    )
    .unwrap();
    assert!(claude["hooks"]["SessionStart"].is_array());
    let codex = std::fs::read_to_string(&config).unwrap();
    assert!(codex.contains("hooks = true") && codex.contains("other = true"));
    assert!(
        std::fs::read_to_string(
            home.path()
                .join(".config/opencode/plugins/magi-linear-axi.js")
        )
        .unwrap()
        .contains("session.created")
    );
}

#[test]
fn clap_definition_and_root_aliases_are_valid() {
    Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["cy", "list"])
        .env("LINEAR_API_KEY", "x")
        .env("LINEAR_API_URL", "http://127.0.0.1:1")
        .assert()
        .failure();
}

#[test]
fn home_needs_no_auth_and_reports_collapsed_binary_path() {
    let binary_path = std::env::var("CARGO_BIN_EXE_magi-linear-axi").unwrap();
    let binary = std::path::Path::new(&binary_path);
    let home = binary.parent().unwrap();
    let output = Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["--format", "json"])
        .env("HOME", home)
        .env_remove("LINEAR_API_KEY")
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(value["bin"].as_str().unwrap().starts_with("~"));
    assert!(
        value["description"]
            .as_str()
            .unwrap()
            .contains("Linear GraphQL")
    );
}
