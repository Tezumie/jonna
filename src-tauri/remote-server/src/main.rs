//! The IDE's remote development server: run on the machine that holds a folder (over SSH, in
//! WSL, or as a local process), it does the window's file, index, search, watch, process and
//! port work there, over one framed JSON connection on standard input and output. The protocol
//! is `docs/remote.md`.

mod error;
mod files;
mod frame;
mod index;
mod outbox;
mod search;
mod server;
mod streams;
mod system;
mod watch;
mod workspace;

const USAGE: &str = "usage: ide-server --stdio | --version";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["--version"] => println!("{}", env!("CARGO_PKG_VERSION")),
        ["--stdio"] => server::serve(),
        // Internal: the login shell runs this to hand its environment back (system.rs).
        ["--print-env"] => std::process::exit(system::print_env()),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}
