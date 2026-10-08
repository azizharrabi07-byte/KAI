// KAI runs without a console window: KAI is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kai_lib::run()
}
