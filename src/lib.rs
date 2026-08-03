pub mod cli;
pub mod client;
pub mod commands;
pub mod config;
pub mod error;
pub mod output;

use clap::Parser;
use cli::Cli;
use error::AppError;

pub struct CommandContext {
    pub config: config::Config,
    pub client: client::LinearClient,
    pub output: output::Output,
}

impl CommandContext {
    pub fn from_cli(cli: &Cli) -> Result<Self, AppError> {
        let config = config::Config::load(cli.endpoint.clone(), cli.workspace.clone())?;
        let token = config::api_key()?;
        Ok(Self {
            client: client::LinearClient::new(config.endpoint.clone(), token)?,
            config,
            output: output::Output::new(cli.format.clone(), cli.full),
        })
    }
}

pub fn run() -> Result<(), AppError> {
    let cli = Cli::try_parse().map_err(|e| AppError::usage(e.to_string()))?;
    cli.execute()
}

pub fn run_with(cli: Cli) -> Result<(), AppError> {
    cli.execute()
}

pub fn main_exit() -> std::process::ExitCode {
    match Cli::try_parse() {
        Ok(cli) => {
            let format = cli.format.clone();
            match cli.execute() {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    error::print(&error, &format);
                    std::process::ExitCode::from(error.exit_code())
                }
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            let error = AppError::usage(error.to_string());
            error::print(&error, "toon");
            std::process::ExitCode::from(2)
        }
    }
}
