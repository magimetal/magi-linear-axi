use crate::{commands, error::AppError};
use clap::CommandFactory;
use clap::{Args, Parser, Subcommand};
use clap_complete::{generate, shells::Shell};
use serde_json::Value;
use std::{
    io::{self, Read},
    path::PathBuf,
};

#[derive(Debug, Parser)]
#[command(
    name = "magi-linear-axi",
    version,
    about = "Agent-native Linear GraphQL CLI",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[arg(long, env = "LINEAR_WORKSPACE", global = true)]
    pub workspace: Option<String>,
    #[arg(long, env = "LINEAR_API_URL", global = true)]
    pub endpoint: Option<String>,
    #[arg(long, global=true, default_value="toon", value_parser=["toon", "json"])]
    pub format: String,
    #[arg(long, global = true)]
    pub full: bool,
    #[command(subcommand)]
    pub command: Option<Command>,
}
#[derive(Debug, Subcommand)]
pub enum Command {
    Api(ApiArgs),
    Schema {
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    Completions {
        shell: Shell,
    },
    Setup(SetupArgs),
    Auth(AuthArgs),
    Issue {
        #[command(subcommand)]
        command: Option<IssueCommand>,
    },
    Team {
        #[command(subcommand)]
        command: TeamCommand,
    },
    User {
        #[command(subcommand)]
        command: UserCommand,
    },
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    #[command(name = "project-update", alias = "pu")]
    ProjectUpdate {
        #[command(subcommand)]
        command: ProjectUpdateCommand,
    },
    #[command(alias = "cy")]
    Cycle {
        #[command(subcommand)]
        command: CycleCommand,
    },
    #[command(alias = "m")]
    Milestone {
        #[command(subcommand)]
        command: MilestoneCommand,
    },
    #[command(alias = "init")]
    Initiative {
        #[command(subcommand)]
        command: InitiativeCommand,
    },
    #[command(name = "initiative-update", alias = "iu")]
    InitiativeUpdate {
        #[command(subcommand)]
        command: InitiativeUpdateCommand,
    },
    #[command(alias = "l")]
    Label {
        #[command(subcommand)]
        command: LabelCommand,
    },
    #[command(alias = "docs", alias = "doc")]
    Document {
        #[command(subcommand)]
        command: DocumentCommand,
    },
}
#[derive(Debug, Args)]
pub struct SetupArgs {
    #[arg(long)]
    pub path: Option<PathBuf>,
    #[arg(long)]
    pub claude: bool,
    #[arg(long)]
    pub codex: bool,
    #[arg(long)]
    pub opencode: bool,
}
#[derive(Debug, Args)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    Whoami,
}
#[derive(Debug, Subcommand)]
pub enum IssueCommand {
    Id(IssueRefArgs),
    Mine(QueryArgs),
    List(QueryArgs),
    Query(QueryArgs),
    Title(IssueRefArgs),
    Start(IssueRefArgs),
    View(IssueRefArgs),
    Url(IssueRefArgs),
    Describe(IssueRefArgs),
    Commits(IssueRefArgs),
    PullRequest(IssueRefArgs),
    Delete(IssueRefArgs),
    Create(IssueCreateArgs),
    Update(IssueUpdateArgs),
    Comment {
        #[command(subcommand)]
        command: CommentCommand,
    },
    Attach(AttachArgs),
    Link(LinkArgs),
    Relation {
        #[command(subcommand)]
        command: RelationCommand,
    },
    AgentSession {
        #[command(subcommand)]
        command: AgentSessionCommand,
    },
}
#[derive(Debug, Args, Clone, Default)]
pub struct IssueRefArgs {
    pub issue: Option<String>,
    #[arg(short = 'w', long)]
    pub web: bool,
    #[arg(short = 'a', long)]
    pub app: bool,
}
#[derive(Debug, Args, Clone, Default)]
pub struct QueryArgs {
    #[arg(long)]
    pub search: Option<String>,
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
    #[arg(long)]
    pub all_teams: bool,
    #[arg(short, long)]
    pub state: Vec<String>,
    #[arg(long)]
    pub assignee: Option<String>,
    #[arg(long)]
    pub unassigned: bool,
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub milestone: Option<String>,
    #[arg(long)]
    pub label: Vec<String>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Debug, Args, Clone, Default)]
pub struct IssueCreateArgs {
    #[arg(short = 't', long)]
    pub title: Option<String>,
    #[arg(short = 'd', long)]
    pub description: Option<String>,
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long)]
    pub assignee: Option<String>,
    #[arg(long)]
    pub priority: Option<i32>,
    #[arg(long)]
    pub state: Option<String>,
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub label: Vec<String>,
    #[arg(long)]
    pub parent: Option<String>,
    #[arg(long)]
    pub start: bool,
}
#[derive(Debug, Args, Clone, Default)]
pub struct IssueUpdateArgs {
    pub issue: Option<String>,
    #[arg(short = 't', long)]
    pub title: Option<String>,
    #[arg(short = 'd', long)]
    pub description: Option<String>,
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long)]
    pub assignee: Option<String>,
    #[arg(long)]
    pub unassign: bool,
    #[arg(short = 'p', long)]
    pub priority: Option<i32>,
    #[arg(long)]
    pub estimate: Option<i32>,
    #[arg(short = 's', long)]
    pub state: Option<String>,
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub milestone: Option<String>,
    #[arg(long)]
    pub cycle: Option<String>,
    #[arg(long)]
    pub clear_cycle: bool,
}
#[derive(Debug, Subcommand)]
pub enum CommentCommand {
    Add(CommentArgs),
    Delete(IssueRefArgs),
    Update(CommentUpdateArgs),
    List(IssueRefArgs),
}
#[derive(Debug, Args, Clone, Default)]
pub struct CommentArgs {
    pub issue: Option<String>,
    #[arg(short = 'b', long)]
    pub body: Option<String>,
    #[arg(short = 'p', long)]
    pub parent: Option<String>,
    #[arg(short = 'a', long)]
    pub attach: Vec<PathBuf>,
    #[arg(long)]
    pub public: bool,
}
#[derive(Debug, Args, Clone, Default)]
pub struct CommentUpdateArgs {
    pub comment: String,
    #[arg(short = 'b', long)]
    pub body: Option<String>,
}
#[derive(Debug, Args, Clone)]
pub struct AttachArgs {
    pub issue: String,
    pub filepath: PathBuf,
    #[arg(short, long)]
    pub title: Option<String>,
    #[arg(short, long)]
    pub comment: Option<String>,
    #[arg(long)]
    pub public: bool,
}
#[derive(Debug, Args, Clone)]
pub struct LinkArgs {
    pub issue: String,
    pub url: String,
    #[arg(short, long)]
    pub title: Option<String>,
}
#[derive(Debug, Subcommand)]
pub enum RelationCommand {
    Add(RelationArgs),
    Delete(RelationArgs),
    List(IssueRefArgs),
}
#[derive(Debug, Args, Clone)]
pub struct RelationArgs {
    pub issue: String,
    pub relation_type: String,
    pub related_issue: String,
}
#[derive(Debug, Args, Clone, Default)]
pub struct ResourceArgs {
    #[arg(value_name = "ID_OR_NAME")]
    pub args: Vec<String>,
    #[arg(short = 'n', long)]
    pub name: Option<String>,
    #[arg(short = 't', long)]
    pub title: Option<String>,
    #[arg(long)]
    pub body: Option<String>,
    #[arg(short = 'c', long)]
    pub content: Option<String>,
    #[arg(long)]
    pub description: Option<String>,
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub issue: Option<String>,
    #[arg(long)]
    pub status: Option<String>,
    #[arg(long)]
    pub health: Option<String>,
    #[arg(long)]
    pub owner: Option<String>,
    #[arg(long = "target-date")]
    pub target_date: Option<String>,
    #[arg(long = "body-file", alias = "content-file")]
    pub file: Option<PathBuf>,
    #[arg(long)]
    pub stdin: bool,
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
    #[arg(long)]
    pub all: bool,
    #[arg(long)]
    pub archived: bool,
    #[arg(long, conflicts_with = "app")]
    pub web: bool,
    #[arg(long, conflicts_with = "web")]
    pub app: bool,
    #[arg(skip)]
    pub open: bool,
}
#[derive(Debug, Subcommand)]
pub enum TeamCommand {
    List(ResourceArgs),
    Create(ResourceArgs),
    Delete(ResourceArgs),
    Id(ResourceArgs),
    Members(ResourceArgs),
    States(ResourceArgs),
    Autolinks(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum UserCommand {
    List(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum ProjectCommand {
    List(ResourceArgs),
    #[command(alias = "v")]
    View(ResourceArgs),
    Create(ResourceArgs),
    Update(ResourceArgs),
    Delete(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum ProjectUpdateCommand {
    #[command(alias = "c")]
    Create(ResourceArgs),
    #[command(alias = "l")]
    List(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum CycleCommand {
    List(ResourceArgs),
    #[command(alias = "v")]
    View(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum MilestoneCommand {
    List(ResourceArgs),
    #[command(alias = "v")]
    View(ResourceArgs),
    Create(ResourceArgs),
    Update(ResourceArgs),
    Delete(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum InitiativeCommand {
    #[command(alias = "ls")]
    List(ResourceArgs),
    #[command(alias = "v")]
    View(ResourceArgs),
    Create(ResourceArgs),
    Archive(ResourceArgs),
    Update(ResourceArgs),
    Unarchive(ResourceArgs),
    Delete(ResourceArgs),
    AddProject(ResourceArgs),
    RemoveProject(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum InitiativeUpdateCommand {
    #[command(alias = "c")]
    Create(ResourceArgs),
    #[command(alias = "l")]
    List(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum LabelCommand {
    List(ResourceArgs),
    Create(ResourceArgs),
    Delete(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum DocumentCommand {
    #[command(alias = "l")]
    List(ResourceArgs),
    #[command(alias = "v")]
    View(ResourceArgs),
    #[command(alias = "c")]
    Create(ResourceArgs),
    #[command(alias = "u")]
    Update(ResourceArgs),
    #[command(alias = "d")]
    Delete(ResourceArgs),
}
#[derive(Debug, Subcommand)]
pub enum AgentSessionCommand {
    List(IssueRefArgs),
    View(IssueRefArgs),
}
#[derive(Debug, Args)]
pub struct ApiArgs {
    pub query: Option<String>,
    #[arg(long="variable", value_parser=commands::parse_variable)]
    pub variable: Vec<(String, Value)>,
    #[arg(long)]
    pub variables_json: Option<String>,
    #[arg(long)]
    pub paginate: bool,
    #[arg(long)]
    pub silent: bool,
}
impl Cli {
    pub fn execute(mut self) -> Result<(), AppError> {
        let command = self.command.take();
        match command {
            None => commands::home(&self),
            Some(Command::Api(a)) => commands::api(&self, a),
            Some(Command::Schema { output }) => commands::schema(&self, output),
            Some(Command::Completions { shell }) => {
                generate(
                    shell,
                    &mut Self::command(),
                    "magi-linear-axi",
                    &mut io::stdout(),
                );
                Ok(())
            }
            Some(Command::Setup(a)) => commands::setup(a),
            Some(Command::Auth(a)) => commands::auth(&self, a.command),
            Some(Command::Issue { command }) => commands::issues(&self, command),
            Some(Command::Team { command }) => commands::team::execute(&self, command),
            Some(Command::User { command }) => commands::user::execute(&self, command),
            Some(Command::Project { command }) => commands::project::execute(&self, command),
            Some(Command::ProjectUpdate { command }) => {
                commands::project_update::execute(&self, command)
            }
            Some(Command::Cycle { command }) => commands::cycle::execute(&self, command),
            Some(Command::Milestone { command }) => commands::milestone::execute(&self, command),
            Some(Command::Initiative { command }) => commands::initiative::execute(&self, command),
            Some(Command::InitiativeUpdate { command }) => {
                commands::initiative_update::execute(&self, command)
            }
            Some(Command::Label { command }) => commands::label::execute(&self, command),
            Some(Command::Document { command }) => commands::document::execute(&self, command),
        }
    }
    pub fn read_query(query: Option<String>) -> Result<String, AppError> {
        let mut q = query.unwrap_or_default();
        if q.trim().is_empty() {
            io::stdin()
                .read_to_string(&mut q)
                .map_err(|e| AppError::usage(e.to_string()))?;
        }
        if q.trim().is_empty() {
            Err(AppError::usage(
                "GraphQL query required as argument or stdin",
            ))
        } else {
            Ok(q)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn root_alias_parses() {
        let cli = Cli::try_parse_from(["magi-linear-axi", "cy", "list"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Cycle { .. })));
    }
}
