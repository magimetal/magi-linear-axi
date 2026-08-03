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
fn setup_is_idempotent_preserves_config_and_installs_context_integrations() {
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
    let executable = assert_cmd::cargo::cargo_bin!("magi-linear-axi")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        claude["hooks"]["SessionStart"][0]["hooks"][0]["command"],
        executable
    );
    let codex_hooks: Value = serde_json::from_str(
        &std::fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        codex_hooks["hooks"]["SessionStart"][0]["command"],
        executable
    );
    let codex = std::fs::read_to_string(&config).unwrap();
    assert!(codex.contains("hooks = true") && codex.contains("other = true"));
    let plugin = std::fs::read_to_string(
        home.path()
            .join(".config/opencode/plugins/magi-linear-axi.js"),
    )
    .unwrap();
    assert!(plugin.contains("export const LinearAxiPlugin"));
    assert!(plugin.contains("experimental.chat.system.transform"));
    assert!(plugin.contains("output.system.push(context)"));
    assert!(plugin.contains(&format!("${{{executable:?}}}")));
    assert!(!plugin.contains("session.created"));
}

#[test]
fn setup_merges_existing_hooks_and_repairs_stale_managed_paths() {
    let home = tempfile::tempdir().unwrap();
    let claude_path = home.path().join(".claude/settings.json");
    let codex_path = home.path().join(".codex/hooks.json");
    std::fs::create_dir_all(claude_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    std::fs::write(
        &claude_path,
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing"}]},{"hooks":[{"type":"command","command":"/old/magi-linear-axi"}]}]}}"#,
    )
    .unwrap();
    std::fs::write(
        &codex_path,
        r#"{"hooks":{"SessionStart":[{"command":"existing"},{"command":"/old/magi-linear-axi"}]}}"#,
    )
    .unwrap();

    Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["setup", "--claude", "--codex"])
        .env("HOME", home.path())
        .assert()
        .success();

    let executable = assert_cmd::cargo::cargo_bin!("magi-linear-axi")
        .to_string_lossy()
        .into_owned();
    let claude: Value =
        serde_json::from_str(&std::fs::read_to_string(claude_path).unwrap()).unwrap();
    let claude_commands: Vec<_> = claude["hooks"]["SessionStart"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .filter_map(|hook| hook["command"].as_str())
        .collect();
    assert!(claude_commands.contains(&"existing"));
    assert_eq!(
        claude_commands.iter().filter(|&&c| c == executable).count(),
        1
    );

    let codex: Value = serde_json::from_str(&std::fs::read_to_string(codex_path).unwrap()).unwrap();
    let codex_commands: Vec<_> = codex["hooks"]["SessionStart"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|hook| hook["command"].as_str())
        .collect();
    assert!(codex_commands.contains(&"existing"));
    assert_eq!(
        codex_commands.iter().filter(|&&c| c == executable).count(),
        1
    );
}

#[test]
fn setup_preserves_malformed_toml() {
    let home = tempfile::tempdir().unwrap();
    let malformed = "endpoint = [";
    let codex = home.path().join(".codex/config.toml");
    std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
    std::fs::write(&codex, malformed).unwrap();
    Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["setup", "--codex"])
        .env("HOME", home.path())
        .assert()
        .failure();
    assert_eq!(std::fs::read_to_string(codex).unwrap(), malformed);
    assert!(!home.path().join(".codex/hooks.json").exists());
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
    let binary = assert_cmd::cargo::cargo_bin!("magi-linear-axi");
    let home = binary.parent().unwrap();
    let output = Command::new(binary)
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
