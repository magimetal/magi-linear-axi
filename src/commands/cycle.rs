use crate::{
    cli::{Cli, CycleCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: CycleCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        CycleCommand::List(a) => ("list", a),
        CycleCommand::View(a) => ("view", a),
    };
    resource::run(c, Kind::Cycle, o, a)
}
