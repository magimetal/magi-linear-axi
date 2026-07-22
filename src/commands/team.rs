use crate::{
    cli::{Cli, TeamCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: TeamCommand) -> Result<(), crate::error::AppError> {
    let (op, a) = match x {
        TeamCommand::List(a) => ("list", a),
        TeamCommand::Create(a) => ("create", a),
        TeamCommand::Delete(a) => ("delete", a),
        TeamCommand::Id(a) => ("id", a),
        TeamCommand::Members(a) => ("members", a),
        TeamCommand::States(a) => ("states", a),
        TeamCommand::Autolinks(a) => ("autolinks", a),
    };
    resource::run(c, Kind::Team, op, a)
}
