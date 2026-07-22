use crate::{
    cli::{Cli, UserCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: UserCommand) -> Result<(), crate::error::AppError> {
    match x {
        UserCommand::List(a) => resource::run(c, Kind::User, "list", a),
    }
}
