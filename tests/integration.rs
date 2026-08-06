use assert_cmd::Command;
use serde_json::{Value, json};
use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Response {
    status: u16,
    content_type: &'static str,
    body: String,
}

impl Response {
    fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
        }
    }
    fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: body.into(),
        }
    }
}

struct Mock {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    thread: thread::JoinHandle<()>,
}

impl Mock {
    fn start(responses: Vec<String>) -> Self {
        Self::scripted(
            responses
                .into_iter()
                .map(|body| Response::json(200, &body))
                .collect(),
        )
    }

    fn scripted(responses: Vec<Response>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/graphql", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let thread = thread::spawn(move || {
            for response in responses {
                let Some(mut stream) = accept_before_timeout(&listener) else {
                    return;
                };
                stream.set_nonblocking(false).unwrap();
                let request = read_request(&mut stream);
                seen.lock().unwrap().push(request);
                let reason = match response.status {
                    200 => "OK",
                    500 => "Internal Server Error",
                    502 => "Bad Gateway",
                    503 => "Service Unavailable",
                    504 => "Gateway Timeout",
                    _ => "Error",
                };
                let body = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.status,
                    reason,
                    response.content_type,
                    response.body.len(),
                    response.body
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

    fn finish(self) -> Vec<String> {
        self.thread.join().unwrap();
        self.requests.lock().unwrap().clone()
    }
}

fn accept_before_timeout(listener: &TcpListener) -> Option<TcpStream> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Some(stream),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("mock accept failed: {error}"),
        }
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
fn graphql_request(request: &str) -> Value {
    let (_, body) = request.split_once("\r\n\r\n").expect("HTTP request body");
    serde_json::from_str(body).expect("GraphQL JSON request")
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

fn run_json(mock: &Mock, args: &[&str]) -> std::process::Output {
    run_json_with_token(mock, args, "lin_api_test")
}

fn run_json_with_token(mock: &Mock, args: &[&str], token: &str) -> std::process::Output {
    Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args(["--format", "json", "--endpoint", &mock.endpoint])
        .args(args)
        .env("LINEAR_API_KEY", token)
        .output()
        .unwrap()
}

fn run_json_request(response: &str, args: &[&str]) -> (std::process::Output, Value) {
    let mock = Mock::start(vec![response.into()]);
    let output = run_json(&mock, args);
    let request = graphql_request(&mock.requests().pop().expect("GraphQL request"));
    mock.thread.join().unwrap();
    (output, request)
}

#[test]
fn read_only_family_retries_500_and_returns_data() {
    let mock = Mock::scripted(vec![
        Response::json(500, "temporary"),
        Response::json(
            200,
            r#"{"data":{"teams":{"nodes":[{"id":"t1"}],"pageInfo":{"hasNextPage":false}}}}"#,
        ),
    ]);
    let output = run_json(&mock, &["team", "list"]);
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["teams"]["nodes"][0]["id"],
        "t1"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("retrying Linear request"));
    assert_eq!(mock.requests().len(), 2);
    mock.thread.join().unwrap();
}

#[test]
fn exhausted_read_retries_exactly_three_times() {
    let mock = Mock::scripted(vec![Response::json(503, "down"); 3]);
    let output = run_json(&mock, &["team", "list"]);
    assert_eq!(output.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], 1);
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("HTTP 503")
    );
    assert_eq!(mock.requests().len(), 3);
    mock.thread.join().unwrap();
}

#[test]
fn mutations_and_uploads_never_retry() {
    let mock = Mock::scripted(vec![Response::json(503, "mutation down")]);
    let output = run_json(&mock, &["issue", "delete", "ENG-1"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(mock.requests().len(), 1);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("retrying Linear request"));
    mock.thread.join().unwrap();

    let file = tempfile::NamedTempFile::new().unwrap();
    let mock = Mock::scripted(vec![Response::json(503, "upload init down")]);
    let output = run_json(
        &mock,
        &["issue", "attach", "ENG-1", file.path().to_str().unwrap()],
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(mock.requests().len(), 1);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("retrying Linear request"));
    mock.thread.join().unwrap();

    let upload_mock = Mock::scripted(vec![
        Response::text(503, "upload down"),
        Response::text(503, "unexpected retry"),
    ]);
    let initialization = format!(
        r#"{{"data":{{"fileUpload":{{"success":true,"uploadFile":{{"assetUrl":"https://assets.example/file","uploadUrl":"{}","headers":[]}}}}}}}}"#,
        upload_mock.endpoint
    );
    let graphql_mock = Mock::scripted(vec![Response::json(200, &initialization)]);
    let output = run_json(
        &graphql_mock,
        &["issue", "attach", "ENG-1", file.path().to_str().unwrap()],
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("HTTP 503"));
    assert_eq!(graphql_mock.requests().len(), 1);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("retrying Linear request"));
    graphql_mock.thread.join().unwrap();
    assert_eq!(upload_mock.finish().len(), 1);
}

#[test]
fn paginated_read_retries_only_failed_cursor_page() {
    let mock = Mock::scripted(vec![
        Response::json(
            200,
            r#"{"data":{"teams":{"nodes":[{"id":"1"}],"pageInfo":{"hasNextPage":true,"endCursor":"c1"}}}}"#,
        ),
        Response::json(502, "bad gateway"),
        Response::json(
            200,
            r#"{"data":{"teams":{"nodes":[{"id":"2"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#,
        ),
    ]);
    let output = run_json(&mock, &["team", "list", "--all"]);
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["teams"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["id"] == "1")
            .count(),
        1
    );
    assert_eq!(value["teams"]["nodes"].as_array().unwrap().len(), 2);
    let requests = mock.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].contains("\"after\":\"c1\"") || requests[1].contains("\"after\": \"c1\""));
    assert_eq!(requests[1].matches("\"after\"").count(), 1);
    assert_eq!(requests[2].matches("\"after\"").count(), 1);
    mock.thread.join().unwrap();
}

#[test]
fn raw_http_errors_preserve_json_and_text_with_bounded_redaction() {
    let mock = Mock::scripted(vec![Response::json(
        500,
        r#"{"errors":[{"message":"resolver unavailable"}]}"#,
    )]);
    let output = run_json(&mock, &["api", "query { viewer { id } }"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("resolver unavailable"));
    assert_eq!(mock.requests().len(), 1);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("retrying Linear request"));
    mock.thread.join().unwrap();

    let token = "lin_api_secret";
    let body = format!(r#"{{"error":"{token}","detail":"{}"}}"#, "x".repeat(1000));
    let mock = Mock::scripted(vec![Response::json(500, &body)]);
    let output = run_json(&mock, &["api", "query { viewer { id } }"]);
    assert_eq!(output.status.code(), Some(1));
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!combined.contains(token));
    assert!(combined.contains("truncated"));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(value["error"]["message"].as_str().unwrap().len() < 600);
    assert_eq!(mock.requests().len(), 1);
    mock.thread.join().unwrap();

    let mock = Mock::scripted(vec![Response::text(500, "plain upstream failure")]);
    let output = run_json(&mock, &["api", "query { viewer { id } }"]);
    assert!(String::from_utf8_lossy(&output.stdout).contains("plain upstream failure"));
    mock.thread.join().unwrap();
}

#[test]
fn graphql_errors_and_failed_delete_are_not_retried() {
    let token = "opaque-secret";
    let mock = Mock::scripted(vec![Response::json(
        200,
        r#"{"errors":[{"message":"bad query opaque-secret"}]}"#,
    )]);
    let output = run_json_with_token(&mock, &["team", "list"], token);
    assert_eq!(output.status.code(), Some(1));
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(combined.contains("bad query"));
    assert!(!combined.contains(token));
    assert_eq!(mock.requests().len(), 1);
    mock.thread.join().unwrap();

    let mock = Mock::scripted(vec![Response::json(
        200,
        r#"{"data":{"issueDelete":{"success":false}}}"#,
    )]);
    let output = run_json(&mock, &["issue", "delete", "ENG-1"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("not successful"));
    mock.thread.join().unwrap();
}

#[test]
fn successful_delete_then_scoped_query_excludes_issue() {
    let mock = Mock::scripted(vec![
        Response::json(200, r#"{"data":{"issueDelete":{"success":true}}}"#),
        Response::json(
            200,
            r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-2"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#,
        ),
    ]);
    let deleted = run_json(&mock, &["issue", "delete", "ENG-1"]);
    assert!(deleted.status.success());

    let listed = run_json(
        &mock,
        &[
            "issue",
            "query",
            "--team",
            "ENG",
            "--search",
            "Retained title",
            "--limit",
            "50",
        ],
    );
    assert!(listed.status.success());
    let value: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert!(
        value["issues"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|issue| issue["identifier"] != "ENG-1")
    );
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("IssueDelete"));
    assert!(requests[0].contains("ENG-1"));
    assert!(requests[1].contains("query Issues"));
    assert!(requests[1].contains("Retained title"));
    assert!(requests[1].contains("ENG"));
    mock.thread.join().unwrap();
}

#[test]
fn issue_null_reads_are_consistent_structured_api_errors() {
    for command in ["title", "url", "describe", "view"] {
        let mock = Mock::scripted(vec![Response::json(200, r#"{"data":{"issue":null}}"#)]);
        let output = run_json(&mock, &["issue", command, "ENG-1"]);
        assert_eq!(output.status.code(), Some(1), "{command}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["type"], "api");
        assert_eq!(value["error"]["code"], 1);
        assert_eq!(value["error"]["message"], "issue ENG-1 not found");
        mock.thread.join().unwrap();
    }
}

#[test]
fn compact_projections_request_only_selected_fields_and_preserve_cardinality() {
    let compact_view_response = r#"{"data":{"issue":{"identifier":"ENG-1","title":"Short","state":{"name":"Todo","type":"backlog"},"url":"https://linear.app/issue/ENG-1"}}}"#;
    let (view, request) = run_json_request(
        compact_view_response,
        &["issue", "view", "ENG-1", "--fields", "compact"],
    );
    assert!(
        view.status.success(),
        "{}",
        String::from_utf8_lossy(&view.stderr)
    );
    assert_eq!(
        request["query"],
        "query Issue($id:String!) { issue(id:$id) { identifier title url state { name type } } }"
    );
    assert_eq!(request["variables"], json!({"id":"ENG-1"}));
    assert_eq!(
        serde_json::from_slice::<Value>(&view.stdout).unwrap(),
        serde_json::from_str::<Value>(compact_view_response).unwrap()["data"]
    );

    let (query, request) = run_json_request(
        r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","title":"Short"}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}}}"#,
        &["issue", "query", "--limit", "7", "--fields", "compact"],
    );
    assert!(query.status.success());
    assert_eq!(
        request["query"],
        "query Issues($filter:IssueFilter,$first:Int,$after:String){issues(filter:$filter,first:$first,after:$after){nodes{identifier title} pageInfo{hasNextPage endCursor}}}"
    );
    assert_eq!(request["variables"]["first"], 7);
    let query_output: Value = serde_json::from_slice(&query.stdout).unwrap();
    assert_eq!(query_output["issues"]["pageInfo"]["hasNextPage"], true);

    let (comments, request) = run_json_request(
        r#"{"data":{"issue":{"comments":{"nodes":[{"id":"c1","body":"Body"}],"pageInfo":{"hasNextPage":true,"endCursor":"comments-next"}}}}}"#,
        &[
            "issue", "comment", "list", "ENG-1", "--fields", "compact", "--limit", "2",
        ],
    );
    assert!(comments.status.success());
    assert_eq!(
        request["query"],
        "query Comments($id:String!,$first:Int,$after:String){issue(id:$id){comments(first:$first,after:$after){nodes{id body} pageInfo{hasNextPage endCursor}}}}"
    );
    assert_eq!(
        request["variables"],
        json!({"id":"ENG-1","first":2,"after":null})
    );
    let comments_output: Value = serde_json::from_slice(&comments.stdout).unwrap();
    assert_eq!(
        comments_output["issue"]["comments"]["pageInfo"]["hasNextPage"],
        true
    );
    assert!(
        comments_output["issue"]["comments"]["nodes"][0]
            .get("createdAt")
            .is_none()
    );

    let (relations, request) = run_json_request(
        r#"{"data":{"issue":{"identifier":"ENG-1","relations":{"nodes":[{"type":"blocks","relatedIssue":{"identifier":"ENG-2","title":"Other"}}],"pageInfo":{"hasNextPage":true,"endCursor":"relations-next"}},"inverseRelations":{"nodes":[{"type":"related","issue":{"identifier":"ENG-3","title":"Third"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}"#,
        &[
            "issue", "relation", "list", "ENG-1", "--fields", "compact", "--limit", "3",
        ],
    );
    assert!(relations.status.success());
    assert_eq!(
        request["query"],
        "query Relations($id:String!,$first:Int,$after:String){issue(id:$id){identifier relations(first:$first,after:$after){nodes{type relatedIssue{identifier title}} pageInfo{hasNextPage endCursor}} inverseRelations(first:$first,after:$after){nodes{type issue{identifier title}} pageInfo{hasNextPage endCursor}}}}"
    );
    assert_eq!(
        request["variables"],
        json!({"id":"ENG-1","first":3,"after":null})
    );
    let relations_output: Value = serde_json::from_slice(&relations.stdout).unwrap();
    assert_eq!(
        relations_output["issue"]["relations"]["pageInfo"]["hasNextPage"],
        true
    );
    assert_eq!(
        relations_output["issue"]["inverseRelations"]["pageInfo"]["hasNextPage"],
        false
    );
    assert!(
        relations_output["issue"]["relations"]["nodes"][0]
            .get("id")
            .is_none()
    );

    let (project, request) = run_json_request(
        r#"{"data":{"project":{"id":"p1","name":"Project","url":"https://linear.app/project/p1","status":{"name":"Planned","type":"planned"}}}}"#,
        &["project", "view", "p1", "--fields", "compact"],
    );
    assert!(project.status.success());
    assert_eq!(
        request["query"],
        "query GetProjectDetails($id:String!){project(id:$id){id name url status{name type}}}"
    );
    let project_output: Value = serde_json::from_slice(&project.stdout).unwrap();
    assert_eq!(project_output["project"].as_object().unwrap().len(), 4);
}

#[test]
fn default_projection_contracts_are_unchanged_and_compact_reduces_mocked_bytes() {
    let cases: &[(&[&str], &str, &str)] = &[
        (
            &["issue", "view", "ENG-1"],
            r#"{"data":{"issue":{"identifier":"ENG-1","title":"Rich issue","url":"https://linear.app/issue/ENG-1","description":"A representative long description for payload comparison","state":{"name":"Todo","type":"backlog"},"assignee":{"name":"Agent"},"comments":{"nodes":[{"id":"c1","body":"Context"}]}}}}"#,
            "query Issue($id:String!) { issue(id:$id) { identifier title url description state { name type } assignee { name } comments { nodes { id body } } } }",
        ),
        (
            &["issue", "query"],
            r#"{"data":{"issues":{"nodes":[{"id":"i1","identifier":"ENG-1","title":"Rich issue","url":"https://linear.app/issue/ENG-1","priority":2,"state":{"name":"Todo","type":"backlog"},"assignee":{"name":"Agent"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#,
            "query Issues($filter:IssueFilter,$first:Int,$after:String){issues(filter:$filter,first:$first,after:$after){nodes{id identifier title url priority state{name type} assignee{name}} pageInfo{hasNextPage endCursor}}}",
        ),
        (
            &["issue", "comment", "list", "ENG-1"],
            r#"{"data":{"issue":{"comments":{"nodes":[{"id":"c1","body":"Body","createdAt":"2026-01-01","user":{"name":"Agent"}}]}}}}"#,
            "query Comments($id:String!){ issue(id:$id){ comments{nodes{id body createdAt user{name}}}}}",
        ),
        (
            &["issue", "relation", "list", "ENG-1"],
            r#"{"data":{"issue":{"identifier":"ENG-1","relations":{"nodes":[{"id":"r1","type":"blocks","relatedIssue":{"identifier":"ENG-2","title":"Other"}}]},"inverseRelations":{"nodes":[]}}}}"#,
            "query Relations($id:String!){issue(id:$id){identifier relations{nodes{id type relatedIssue{identifier title}}} inverseRelations{nodes{id type issue{identifier title}}}}}",
        ),
        (
            &["project", "view", "p1"],
            r##"{"data":{"project":{"id":"p1","name":"Project","description":"Description","slugId":"project","url":"https://linear.app/project/p1","status":{"name":"Planned","type":"planned","color":"#fff"},"lead":{"name":"Lead","displayName":"Lead"},"priority":1,"health":"onTrack","startDate":"2026-01-01","targetDate":"2026-02-01","createdAt":"2026-01-01","updatedAt":"2026-01-02"}}}"##,
            "query GetProjectDetails($id:String!){project(id:$id){id name description slugId url status{name type color} lead{name displayName} priority health startDate targetDate createdAt updatedAt}}",
        ),
    ];

    let mut default_view_bytes = None;
    for (args, response, expected_query) in cases {
        let (output, request) = run_json_request(response, args);
        assert!(output.status.success(), "{args:?}");
        assert_eq!(request["query"], *expected_query, "{args:?}");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            serde_json::from_str::<Value>(response).unwrap()["data"],
            "{args:?}"
        );
        if *args == ["issue", "view", "ENG-1"] {
            default_view_bytes = Some((
                request["query"].as_str().unwrap().len(),
                output.stdout.len(),
            ));
        }
    }

    let compact_response = r#"{"data":{"issue":{"identifier":"ENG-1","title":"Rich issue","url":"https://linear.app/issue/ENG-1","state":{"name":"Todo","type":"backlog"}}}}"#;
    let (compact, request) = run_json_request(
        compact_response,
        &["issue", "view", "ENG-1", "--fields", "compact"],
    );
    let (default_query_bytes, default_output_bytes) = default_view_bytes.unwrap();
    let compact_query_bytes = request["query"].as_str().unwrap().len();
    assert_eq!((default_query_bytes, compact_query_bytes), (148, 87));
    assert_eq!((default_output_bytes, compact.stdout.len()), (287, 134));
}

#[test]
fn compact_mine_preserves_default_toon_and_pagination_state() {
    let mock = Mock::start(vec![
        r#"{"data":{"viewer":{"id":"viewer-1"}}}"#.into(),
        r#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","title":"Short"}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}}}"#.into(),
    ]);
    let output = Command::cargo_bin("magi-linear-axi")
        .unwrap()
        .args([
            "--endpoint",
            &mock.endpoint,
            "issue",
            "mine",
            "--fields",
            "compact",
        ])
        .env("LINEAR_API_KEY", "lin_api_test")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("issues") && stdout.contains("ENG-1"));
    assert!(stdout.contains("hasNextPage: true"));
    assert!(!stdout.trim_start().starts_with('{'));
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let query = graphql_request(&requests[1]);
    assert_eq!(
        query["query"],
        "query Issues($filter:IssueFilter,$first:Int,$after:String){issues(filter:$filter,first:$first,after:$after){nodes{identifier title} pageInfo{hasNextPage endCursor}}}"
    );
    assert_eq!(
        query["variables"]["filter"]["assignee"]["id"]["eq"],
        "viewer-1"
    );
    mock.thread.join().unwrap();
}

#[test]
fn unsupported_field_selections_fail_before_auth_or_network() {
    for args in [
        &["issue", "view", "ENG-1", "--fields", "wide"][..],
        &["issue", "title", "ENG-1", "--fields", "compact"][..],
        &["issue", "comment", "list", "ENG-1", "--limit", "1"][..],
        &["project", "update", "p1", "--fields", "compact"][..],
        &["issue", "view", "ENG-1", "--fields", "compact", "--web"][..],
        &["project", "view", "p1", "--fields", "compact", "--app"][..],
    ] {
        let output = Command::cargo_bin("magi-linear-axi")
            .unwrap()
            .args(args)
            .env_remove("LINEAR_API_KEY")
            .env("LINEAR_API_URL", "http://127.0.0.1:1/graphql")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
    }
}
