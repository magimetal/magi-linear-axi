use crate::{
    cli::{Cli, LabelCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: LabelCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        LabelCommand::List(a) => ("list", a),
        LabelCommand::Create(a) => ("create", a),
        LabelCommand::Delete(a) => ("delete", a),
    };
    resource::run(c, Kind::Label, o, a)
}
