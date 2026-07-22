use crate::{
    cli::{Cli, InitiativeUpdateCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: InitiativeUpdateCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        InitiativeUpdateCommand::List(a) => ("list", a),
        InitiativeUpdateCommand::Create(a) => ("create", a),
    };
    resource::run(c, Kind::InitiativeUpdate, o, a)
}
