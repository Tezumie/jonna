//! The windowless host program (`src/host/`): the IDE's services over a byte stream.

fn main() {
    std::process::exit(ide_lib::host_program());
}
