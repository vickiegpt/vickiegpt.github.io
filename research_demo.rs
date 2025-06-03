use std::process::Command;
use std::arch::asm;
use std::sync::atomic::{fence, Ordering};

#[derive(Debug)]
struct Paper {
    data: Vec<u8>,
}

#[derive(Debug)]
enum Error {
    ProcessError(std::io::Error),
    InvalidPaper,
}

impl Paper {
    fn new(output: std::process::Output) -> Self {
        Paper {
            data: output.stdout,
        }
    }

    fn iter(&self) -> std::slice::Iter<u8> {
        self.data.iter()
    }

    fn is_valid(&self) -> bool {
        !self.data.is_empty()
    }
}

fn research_no_failure() -> Result<Paper, Error> {
    let output = if cfg!(target_os = "linux") {
        Command::new("qemu-system-x86_64")
            .args([
                "-smp", "6",
                "-numa", "node,cpus=0-7,memdev=mem0,nodeid=0",
                "-object", "memory-backend-ram,id=mem0,size=8G",
                "-numa", "node,cpus=8-15,memdev=mem1,nodeid=1",
                "-object", "memory-backend-ram,id=mem1,size=8G",
                "-m", "16G,slots=4,maxmem=32G",
                "-machine", "q35,cxl=on",
                "-M", "cxl-fmw.0.targets.0=cxl.1,cxl-fmw.0.size=4G",
                "-device", "pxb-cxl,bus_nr=12,bus=pcie.0,id=cxl.1",
                "-device", "cxl-rp,port=0,bus=cxl.1,id=root_port13,chassis=0,slot=2",
                "-device", "cxl-type3,bus=root_port13,memdev=cxl-mem1,lsa=cxl-lsa1,id=cxl-mem0",
            ])
            .output()
            .map_err(Error::ProcessError)?
    } else {
        // Fallback for non-Linux systems
        Command::new("echo")
            .arg("CXL simulation not available on this platform")
            .output()
            .map_err(Error::ProcessError)?
    };

    let paper = Paper::new(output);
    
    loop {
        // Cache flush simulation - only works on x86_64
        #[cfg(target_arch = "x86_64")]
        unsafe {
            let ptr = paper.data.as_ptr();
            asm!("clflush [{}]", in(reg) ptr, options(nostack, preserves_flags));
        }
        
        fence(Ordering::SeqCst);
        
        if paper.is_valid() {
            break;
        }
    }
    
    Ok(paper)
}

fn main() {
    match research_no_failure() {
        Ok(paper) => println!("Research completed successfully: {:?}", paper),
        Err(e) => eprintln!("Research failed: {:?}", e),
    }
}